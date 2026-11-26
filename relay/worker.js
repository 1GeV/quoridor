import { DurableObject } from "cloudflare:workers";
import { MAX_ROOM_FRAME_CHARS } from "../room-ws-protocol.js";
export { default } from "./router.js";

const ROOM_AGE_MS = 6 * 60 * 60 * 1000;
const BURST = 16;
const FRAME = /^![\w-]+$/;

export class Room extends DurableObject {
  active(role) {
    return this.ctx.getWebSockets(role).find((socket) => socket.readyState === 1 && socket.deserializeAttachment());
  }

  fetch(request) {
    const role = new URL(request.url).pathname.split("/").at(-1);
    const [client, server] = Object.values(new WebSocketPair());
    const occupied = this.active(role);
    const host = role === "guest" ? this.active("host") : null;
    const now = Date.now();
    const expiresAt = role === "host" ? now + ROOM_AGE_MS : host?.deserializeAttachment()?.expiresAt;
    this.ctx.acceptWebSocket(server, [role]);
    if (occupied) {
      server.close(4003, "This room seat is already connected.");
    } else if (!expiresAt || expiresAt <= now) {
      server.close(4004, "The host is unavailable. Ask them to keep the room open.");
    } else {
      server.serializeAttachment({ role, expiresAt, tokens: BURST, updatedAt: now });
      if (host) {
        const pairing = crypto.randomUUID();
        server.send("ready " + pairing);
        host.send("peer-ready " + pairing);
      } else {
        server.send("ready");
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const seat = socket.deserializeAttachment();
    if (!seat || Date.now() >= seat.expiresAt) {
      socket.close(4004, "This room has expired. Create a new room.");
      return;
    }
    if (typeof message !== "string" || message.length > MAX_ROOM_FRAME_CHARS || !FRAME.test(message)) {
      socket.close(4002, "Invalid room message.");
      return;
    }
    const now = Date.now();
    const tokens = Math.min(BURST, seat.tokens + Math.max(0, now - seat.updatedAt) / 500);
    if (tokens < 1) {
      socket.close(4008, "Too many room messages. Rejoin to continue.");
      return;
    }
    socket.serializeAttachment({ ...seat, tokens: tokens - 1, updatedAt: now });
    const opponent = this.active(seat.role === "host" ? "guest" : "host");
    if (opponent) opponent.send(message);
  }

  webSocketClose(socket, code, reason) {
    this.disconnect(socket);
    const valid = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
    socket.close(valid ? code : 1000, valid ? reason : "");
  }

  webSocketError(socket) {
    this.disconnect(socket);
    socket.close(1011, "Room connection failed.");
  }

  disconnect(socket) {
    const seat = socket.deserializeAttachment();
    if (!seat) return;
    socket.serializeAttachment(null);
    if (this.active(seat.role)) return;
    const opponent = this.active(seat.role === "host" ? "guest" : "host");
    if (!opponent) return;
    if (seat.role === "host") opponent.close(4004, "The host disconnected. Rejoin to continue.");
    else opponent.send("peer-left");
  }
}
