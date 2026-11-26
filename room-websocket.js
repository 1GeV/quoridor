import { base64, isRelayCode, unbase64 } from "./room-crypto.js";
import { MAX_ROOM_FRAME_CHARS, MAX_ROOM_MESSAGE_BYTES } from "./room-ws-protocol.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const RECONNECT_DELAYS = [500, 1500, 4000];
const PAIRING = /^[0-9a-f-]{36}$/;

export async function openSocketRoom(endpoint, code, host, { onGuest, onStatus, signal } = {}) {
  if (!isRelayCode(code) || !code.startsWith("W-")) throw new Error("Invalid WebSocket room invitation.");
  const url = new URL(endpoint);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("Invalid room relay URL.");
  }
  const roomSecret = code.slice(2);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode("quoridor-ws-v1:" + roomSecret));
  const roomId = base64(new Uint8Array(digest));
  const key = await crypto.subtle.importKey("raw", unbase64(roomSecret), "AES-GCM", false, ["encrypt", "decrypt"]);
  const role = host ? "host" : "guest";
  const opponent = host ? "guest" : "host";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/rooms/" + roomId + "/" + role;
  url.search = url.hash = "";
  signal?.throwIfAborted();

  let socket, channel, reconnectTimer, reconnectCount = 0, closed = false;
  const dispose = () => {
    closed = true;
    clearTimeout(reconnectTimer);
    channel?.stop();
    socket?.close();
  };
  signal?.addEventListener("abort", dispose, { once: true });

  function pair(ws, pairing) {
    const handlers = new Map();
    let received = 0, sent = 0;
    let pendingRead = Promise.resolve(), pendingWrite = Promise.resolve();
    const outgoing = encoder.encode(roomId + ":" + pairing + ":" + role);
    const incoming = encoder.encode(roomId + ":" + pairing + ":" + opponent);
    const emit = (event, value) => {
      for (const callback of handlers.get(event) ?? []) callback(value);
    };
    const link = {
      open: true,
      on(event, callback) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(callback);
      },
      stop(error) {
        if (!link.open) return;
        link.open = false;
        if (channel === link) channel = null;
        if (error) emit("error", error);
        emit("close");
        handlers.clear();
      },
      close(error) {
        link.stop(error);
        if (!host && ws.readyState < WebSocket.CLOSING) ws.close();
      },
      send(message) {
        if (!link.open || ws.readyState !== WebSocket.OPEN) throw new Error("The room relay is disconnected.");
        const bytes = encoder.encode(JSON.stringify([++sent, message]));
        if (bytes.length > MAX_ROOM_MESSAGE_BYTES) {
          sent--;
          throw new Error("The room game is too large to synchronize.");
        }
        pendingWrite = pendingWrite.then(async () => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: outgoing }, key, bytes));
          if (!link.open || ws.readyState !== WebSocket.OPEN) return;
          const frame = new Uint8Array(iv.length + encrypted.length);
          frame.set(iv);
          frame.set(encrypted, iv.length);
          ws.send("!" + base64(frame));
        }).catch(() => link.close(new Error("The room relay could not send a message.")));
      },
      receive(frame) {
        pendingRead = pendingRead.then(async () => {
          if (!link.open || frame.length > MAX_ROOM_FRAME_CHARS) return;
          const bytes = unbase64(frame.slice(1));
          const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: incoming }, key, bytes.subarray(12));
          if (!link.open || plain.byteLength > MAX_ROOM_MESSAGE_BYTES) return;
          const [sequence, message] = JSON.parse(decoder.decode(plain));
          if (!Number.isSafeInteger(sequence) || sequence <= received) return;
          if (sequence !== received + 1) throw new Error("Missing room message.");
          received = sequence;
          emit("data", message);
        }).catch(() => {
          link.close(new Error("A room message could not be verified. Rejoin to synchronize."));
        });
      },
    };
    return link;
  }

  function connect() {
    const ws = socket = new WebSocket(url);
    let ready = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!ready) reject(new Error("The room relay did not respond."));
        ws.close();
      }, 10_000);
      ws.addEventListener("message", ({ data }) => {
        if (closed || socket !== ws || typeof data !== "string") return;
        if (!ready) {
          if (host ? data !== "ready" : !(data.startsWith("ready ") && PAIRING.test(data.slice(6)))) return;
          if (!host) channel = pair(ws, data.slice(6));
          ready = true;
          reconnectCount = 0;
          clearTimeout(timeout);
          resolve();
          onStatus?.(true);
          return;
        }
        if (host && data.startsWith("peer-ready ") && PAIRING.test(data.slice(11))) {
          channel?.stop();
          channel = pair(ws, data.slice(11));
          onGuest(channel);
        } else if (host && data === "peer-left") {
          channel?.stop();
        } else if (data.startsWith("!")) {
          channel?.receive(data);
        }
      });
      ws.addEventListener("close", ({ code: closeCode, reason }) => {
        clearTimeout(timeout);
        const error = new Error(reason || "The room relay is unavailable. Try again later.");
        if (!ready) reject(signal?.aborted ? signal.reason : error);
        if (closed || socket !== ws) return;
        channel?.stop(reason ? error : undefined);
        if (!ready) return;
        if (host && (closeCode === 1001 || closeCode === 1006 || closeCode === 1011)) {
          onStatus?.(false);
          reconnectHost();
        } else {
          onStatus?.(false, reason ? error : new Error("The room relay disconnected. Rejoin with the same invitation."));
        }
      });
    });
  }

  function reconnectHost() {
    if (closed) return;
    if (reconnectCount === RECONNECT_DELAYS.length) {
      onStatus?.(false, new Error("The room relay could not reconnect. Try creating a new room."));
      return;
    }
    reconnectTimer = setTimeout(() => {
      void connect().catch(reconnectHost);
    }, RECONNECT_DELAYS[reconnectCount++]);
  }

  try {
    await connect();
  } catch (error) {
    dispose();
    signal?.removeEventListener("abort", dispose);
    throw error;
  }
  return {
    join() {
      if (!channel?.open) throw new Error("The host disconnected. Rejoin to continue.");
      return channel;
    },
  };
}
