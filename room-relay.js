// Encrypted room messages over ntfy's anonymous HTTPS publish/subscribe API.
import { base64, unbase64, newRelayCode } from "./room-crypto.js";
export { isRelayCode, newRelayCode } from "./room-crypto.js";
const RELAY = "https://ntfy.sh/";
const encoder = new TextEncoder(), decoder = new TextDecoder();
const CHUNK_BYTES = 1800;
const MAX_MESSAGE_BYTES = 256 * 1024;
const RETRY_DELAYS = [0, 250, 900];
const RATE_LIMIT_DELAY = 6000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canRetryRateLimit(response, code) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const milliseconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(milliseconds)) return milliseconds <= RATE_LIMIT_DELAY;
  }
  // ntfy refills its request allowance roughly every five seconds.
  return code === 42901;
}

async function postMessage(outbox, body, isActive) {
  let attempt = 0, delay = 0, rateLimitRetried = false;
  while (attempt < RETRY_DELAYS.length) {
    if (!isActive()) return;
    if (delay) await wait(delay);
    if (!isActive()) return;
    let response;
    try {
      response = await fetch(outbox, {
        method: "POST", body,
        headers: { Cache: "no", Firebase: "no" },
        credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(5000),
      });
    } catch {
      delay = RETRY_DELAYS[++attempt];
      continue;
    }
    if (response.ok) return;
    if (response.status === 429) {
      const { code } = await response.json().catch(() => ({})) ?? {};
      if (code === 42908) throw new Error("The free room relay's daily message limit has been reached. Try again after it resets, or start a Direct room.");
      if (!rateLimitRetried && canRetryRateLimit(response, code)) {
        rateLimitRetried = true;
        delay = RATE_LIMIT_DELAY;
        continue;
      }
      throw new Error("The free room relay is limiting requests. Wait before rejoining with the same invitation.");
    }
    if (response.status < 500) break;
    delay = RETRY_DELAYS[++attempt];
  }
  throw new Error("The room relay could not deliver a message.");
}

export async function openRelayRoom(code, host, { onGuest, onStatus, signal } = {}) {
  const text = code.slice(2);
  const key = await crypto.subtle.importKey("raw", unbase64(text), "AES-GCM", false, ["encrypt", "decrypt"]);
  const topic = async (role) => {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`quoridor-room-v1:${role}:${text}`));
    return RELAY + "quoridor-" + base64(new Uint8Array(digest));
  };
  const [inbox, outbox] = await Promise.all([
    topic(host ? "host" : "guest"), topic(host ? "guest" : "host"),
  ]);
  signal?.throwIfAborted();
  const incoming = encoder.encode(inbox), outgoing = encoder.encode(outbox);
  const stream = new EventSource(inbox + "/sse");
  let channel = null, ready = false, closed = false;
  const joined = new Set();
  let pendingRead = Promise.resolve(), pendingWrite = Promise.resolve();
  let resolveReady, rejectReady;
  const firstConnection = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const connectionTimer = setTimeout(() => {
    rejectReady(new Error("The room relay did not respond."));
  }, 12000);
  function destroy() {
    closed = true;
    channel?.close();
    stream.close();
    signal?.removeEventListener("abort", cancel);
  }
  function cancel() {
    rejectReady(signal.reason);
    destroy();
  }
  signal?.addEventListener("abort", cancel, { once: true });

  function publish(packet, isActive = () => true) {
    const post = pendingWrite.then(async () => {
      if (!isActive()) return;
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const data = encoder.encode(JSON.stringify(packet));
      const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: outgoing }, key, data));
      await postMessage(outbox, base64(nonce) + "." + base64(bytes), isActive);
    });
    pendingWrite = post.catch(() => {});
    return post;
  }

  function makeChannel(id) {
    const handlers = new Map();
    const chunks = [];
    let sent = 0, received = 0, size = 0;
    const emit = (name, value) => handlers.get(name)?.forEach((callback) => callback(value));
    const link = {
      id, open: true,
      on(name, callback) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(callback);
      },
      stop(notify) {
        if (!link.open) return;
        link.open = false;
        chunks.length = 0;
        if (channel === link) channel = null;
        if (notify && ready) void publish({ id, kind: "leave" }).catch(() => {});
        emit("close");
        handlers.clear();
      },
      close() { link.stop(true); },
      send(message) {
        if (!link.open || !ready) throw new Error("The room relay is disconnected.");
        const bytes = encoder.encode(JSON.stringify(message));
        if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("The room game is too large to synchronize.");
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const packet = {
            id, kind: "data", seq: ++sent, part: base64(bytes.subarray(offset, offset + CHUNK_BYTES)),
            last: offset + CHUNK_BYTES >= bytes.length,
          };
          void publish(packet, () => link.open).catch((error) => {
            if (link.open) { emit("error", error); link.stop(false); }
          });
        }
      },
      receive(packet) {
        if (packet.kind === "leave") { link.stop(false); return; }
        if (packet.kind !== "data" || !Number.isSafeInteger(packet.seq) || packet.seq <= received) return;
        if (packet.seq !== received + 1 || typeof packet.part !== "string" || packet.part.length > 2400) {
          emit("error", new Error("A room message was missed. Rejoin to synchronize."));
          link.stop(false);
          return;
        }
        const part = unbase64(packet.part);
        size += part.length;
        if (size > MAX_MESSAGE_BYTES) { link.stop(false); return; }
        received++;
        chunks.push(part);
        if (!packet.last) return;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        size = 0;
        emit("data", JSON.parse(decoder.decode(bytes)));
      },
    };
    return link;
  }

  async function receive(event) {
    let packet;
    try {
      const text = JSON.parse(event.data).message;
      if (typeof text !== "string" || text.length > 4096) return;
      const [nonce, body] = text.split(".");
      if (nonce?.length !== 16 || !body) return;
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(nonce), additionalData: incoming }, key, unbase64(body));
      packet = JSON.parse(decoder.decode(bytes));
    } catch { return; }
    if (closed || !ready || !packet || typeof packet.id !== "string" || !/^[\w-]{22}$/.test(packet.id)) return;
    if (host && packet.kind === "join" && !joined.has(packet.id)) {
      joined.add(packet.id);
      channel?.close();
      channel = makeChannel(packet.id);
      onGuest(channel);
    } else if (packet.id === channel?.id) channel.receive(packet);
  }
  stream.addEventListener("open", (event) => {
    if (typeof event.data !== "string") return;
    ready = true;
    resolveReady();
    onStatus?.(true);
  });
  stream.onmessage = (event) => {
    pendingRead = pendingRead.then(() => receive(event)).catch(() => channel?.stop(false));
  };
  stream.onerror = () => {
    ready = false;
    if (channel) channel.stop(false);
    onStatus?.(false);
  };

  try { await firstConnection; }
  catch (error) { destroy(); throw error; }
  finally { clearTimeout(connectionTimer); }

  return {
    join() {
      channel = makeChannel(newRelayCode());
      const link = channel;
      void publish({ id: link.id, kind: "join" }, () => link.open).catch((error) => {
        if (link.open) { link.stop(false); onStatus?.(false, error); }
      });
      return link;
    },
  };
}
