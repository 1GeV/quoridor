import test from "node:test";
import assert from "node:assert/strict";
import { newRelayCode, openRelayRoom } from "../room-relay.js";

test("anonymous relay retries an interrupted send without replaying a move", async (t) => {
  const streams = new Map(), requests = [];
  let interrupt = false;
  class Stream {
    constructor(url) {
      this.url = url.replace(/\/sse$/, "");
      streams.set(this.url, this);
    }
    addEventListener(type, listener) {
      assert.equal(type, "open");
      queueMicrotask(() => listener({ data: "{}" }));
    }
    close() { streams.delete(this.url); }
  }
  t.mock.method(globalThis, "fetch", async (url, request) => {
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers.Cache, "no");
    requests.push({ url, body: request.body });
    streams.get(url)?.onmessage({ data: JSON.stringify({ message: request.body }) });
    if (interrupt) { interrupt = false; throw new TypeError("Connection reset after delivery"); }
    return { ok: true };
  });
  const oldEventSource = globalThis.EventSource;
  globalThis.EventSource = Stream;
  const hostController = new AbortController(), guestController = new AbortController();
  t.after(() => {
    for (const stream of streams.values()) stream.onerror();
    hostController.abort();
    guestController.abort();
    if (oldEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = oldEventSource;
  });
  const code = "R-" + newRelayCode();
  const incoming = Promise.withResolvers();
  await openRelayRoom(code, true, { onGuest: incoming.resolve, signal: hostController.signal });
  const guest = await openRelayRoom(code, false, { signal: guestController.signal });
  const guestChannel = guest.join();
  const hostChannel = await incoming.promise;
  const move = { t: "move", a: 67, ply: 0 }, confirmed = Promise.withResolvers();
  const allMoves = [];
  guestChannel.on("data", (message) => {
    allMoves.push(message);
    if (message.ply === 1) confirmed.resolve();
  });
  interrupt = true;
  hostChannel.send(move);
  const next = { t: "move", a: 13, ply: 1 };
  hostChannel.send(next);
  await confirmed.promise;
  assert.deepEqual(allMoves, [move, next]);
  assert.equal(requests.length, 4);
  assert.equal(requests[1].body, requests[2].body);
  for (const { url, body } of requests) {
    assert.ok(!url.includes(code.slice(2)) && !body.includes(code.slice(2)));
    assert.ok(!body.includes(JSON.stringify(move)));
  }
});
