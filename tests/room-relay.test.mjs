import test from "node:test";
import assert from "node:assert/strict";
import { newRelayCode, openRelayRoom } from "../room-relay.js";

async function mockedRoom(t, reply) {
  const streams = new Map(), requests = [];
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
    const deliver = () => streams.get(url)?.onmessage({ data: JSON.stringify({ message: request.body }) });
    return reply(deliver);
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
  return { code, requests, hostChannel, guestChannel };
}

test("anonymous relay retries an interrupted send without replaying a move", async (t) => {
  let interrupt = false;
  const { code, requests, hostChannel, guestChannel } = await mockedRoom(t, (deliver) => {
    deliver();
    if (interrupt) { interrupt = false; throw new TypeError("Connection reset after delivery"); }
    return { ok: true };
  });
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

test("relay retries a brief request limit once and stops queued sends at the daily limit", { timeout: 2000 }, async (t) => {
  let nextLimit = null;
  const { requests, hostChannel, guestChannel } = await mockedRoom(t, (deliver) => {
    if (nextLimit !== null) {
      const code = nextLimit;
      nextLimit = null;
      return Response.json({ code }, { status: 429 });
    }
    deliver();
    return { ok: true };
  });
  const realTimeout = globalThis.setTimeout;
  const cooldowns = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 6000) { cooldowns.push(delay); return realTimeout(callback, 0, ...args); }
    return realTimeout(callback, delay, ...args);
  });
  const received = Promise.withResolvers();
  guestChannel.on("data", received.resolve);
  const move = { t: "move", a: 67, ply: 0 };
  nextLimit = 42901;
  hostChannel.send(move);
  assert.deepEqual(await received.promise, move);
  assert.deepEqual(cooldowns, [6000]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[2]);

  const failure = Promise.withResolvers();
  hostChannel.on("error", failure.resolve);
  nextLimit = 42908;
  hostChannel.send({ t: "move", a: 13, ply: 1 });
  hostChannel.send({ t: "move", a: 58, ply: 2 });
  assert.match((await failure.promise).message, /daily message limit/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cooldowns, [6000]);
  assert.equal(requests.length, 4);
});
