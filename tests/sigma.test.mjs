// Parity test: the browser encoder and wasm inference must match the Python
// reference bit for bit (encode hash) and numerically (logits, value).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { State } from "../rules.js";
import { actionIndex, encode, legalIndexMap, SigmaAgent, SigmaNet } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(fs.readFileSync(path.join(here, "sigma_ref.json"), "utf-8"));
const model = path.join(here, "..", "models", "sigma_9x9.onnx");

async function loadOrt() {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  globalThis.ort = ort;
  return ort;
}

test("encoder hash matches the Python reference", () => {
  let s = State.new();
  for (const a of [67, 13, 117, 58, 22]) s = s.doAction(a);
  assert.equal(s.ply, ref.ply);
  assert.deepEqual(s.pos, ref.pos);
  assert.deepEqual(s.walls, ref.walls);
  const buf = Buffer.from(encode(s).buffer);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  assert.equal(sha, ref.encode_sha, "encode() differs from Python");
});

test("Sigma keeps the legal diagonal around a horizontally adjacent pawn", async () => {
  // The straight jump over e5 is blocked. Red can go from d5 to e4
  // via e5 even though d5 cannot step directly toward d4. Check the
  // reflected position for Blue too; both use the same policy index.
  for (const side of [0, 1]) {
    const state = State.new();
    state.turn = side;
    state.pos = side === 0 ? [39, 40] : [40, 39];
    state.hw[(side === 0 ? 3 : 4) * 8 + 2] = 1;
    state.vw[4 * 8 + 4] = 1;
    const sidestep = side === 0 ? 31 : 49;
    const blocked = side === 0 ? 30 : 48;
    assert.ok(state.moves().includes(sidestep));
    assert.equal(actionIndex(state, blocked), null);
    const mapped = legalIndexMap(state);
    assert.deepEqual(mapped.map(([, move]) => move), state.legal());
    assert.equal(new Set(mapped.map(([index]) => index)).size, mapped.length);
    assert.equal(actionIndex(state, sidestep), 5);
    const logits = new Float32Array(136).fill(-10);
    logits[5] = 10;
    const net = new SigmaNet(null, () => ({ logits, values: [0] }));
    const agent = new SigmaAgent(net, { sims: 0 });
    assert.equal(await agent.choose(state), sidestep);
  }
});

test("wasm inference reproduces the Python logits", async (t) => {
  await loadOrt();
  let s = State.new();
  for (const a of [67, 13, 117, 58, 22]) s = s.doAction(a);
  const net = await SigmaNet.load(model);
  const [logits, value] = await net.raw(s);
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(logits[i] - ref.logits8[i]) < 2e-4,
      `logit ${i}: ${logits[i]} vs ${ref.logits8[i]}`);
  }
  assert.ok(Math.abs(value - ref.value) < 2e-4, `value ${value} vs ${ref.value}`);
});

test("a 48-simulation search finishes and returns a legal action", async () => {
  const ort = await loadOrt();
  const net = await SigmaNet.load(model, ort);
  const { SigmaAgent } = await import("../sigma.js");
  const agent = new SigmaAgent(net, { sims: 48 });
  let s = State.new();
  for (const a of [67, 13]) s = s.doAction(a);
  const t0 = Date.now();
  const a = await agent.choose(s, { temperature: 0 });
  const ms = Date.now() - t0;
  assert.ok(s.legal().includes(a), "search returned an illegal action");
  console.log(`      48 sims took ${ms} ms in node(wasm)`);
});

test("the exact race solver accounts for jumps after move 200", async () => {
  const { raceMove, raceValue } = await import("../endgame.js");
  const s = State.new();
  s.walls = [0, 0];
  assert.equal(raceValue(s), -1); // blue wins the head-on jump race with best play
  s.pos = [22, 13];
  s.ply = 204;
  assert.equal(raceMove(s), 4);
  assert.equal(raceValue(s), 1);

});

test("Sigma respects an expired or cancelled search", async () => {
  const { SigmaBatchAgent } = await import("../sigma.js");
  let calls = 0;
  const agent = new SigmaBatchAgent({
    async evaluate(state) { calls++; return [{ [state.moves()[0]]: 1 }, 0]; },
  });
  const s = State.new();
  assert.equal(await agent.choose(s, { cancelled: () => true }), null);
  assert.equal(calls, 0);
  assert.equal(await agent.choose(s, { ms: 0 }), 67);
  assert.equal(agent.lastSims, 0);
  assert.equal(calls, 1);
});

test("batch model matches single inference and the batched agent plays legally", async () => {
  const ort = await loadOrt();
  const batchModel = path.join(here, "..", "models", "sigma_9x9_batch.onnx");
  const net = await SigmaNet.load(batchModel, ort, { executionProviders: ["wasm"] });
  let s = State.new();
  for (const a of [67, 13, 117]) s = s.doAction(a);
  const [logits, value] = await net.raw(s);
  const [one] = await net.rawBatch([s]);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(logits[i] - one.logits[i]) < 2e-4);
  assert.ok(Math.abs(value - one.value) < 2e-4);
  const { SigmaBatchAgent } = await import("../sigma.js");
  const agent = new SigmaBatchAgent(net, { sims: 32, batch: 8 });
  const a = await agent.choose(s, { temperature: 0 });
  assert.ok(s.legal().includes(a), "batched search returned an illegal action");
});


test("Sigma reuses inference across move counts even after move 200", async () => {
  let calls = 0;
  const net = {
    async evaluate(state) {
      calls++;
      return [{ [state.moves()[0]]: 1 }, 0];
    },
  };
  const agent = new SigmaAgent(net, { sims: 1 });
  const opening = State.new();
  const move = await agent.choose(opening);
  assert.equal(calls, 2);
  const late = opening.clone();
  late.ply = 200;
  assert.equal(await agent.choose(late), move);
  assert.equal(agent.lastCacheHits, 2);
  assert.equal(calls, 2);
  agent.reset();
  await agent.choose(opening);
  assert.equal(calls, 4);
});

test("Sigma fills a batch with distinct positions even when the policy favors one move", async () => {
  const { SigmaBatchAgent } = await import("../sigma.js");
  const opening = State.new();
  const choices = opening.moves();
  const batches = [];
  const net = {
    async evaluate(state) {
      const priors = state === opening
        ? Object.fromEntries(choices.map((move, i) => [move, i === 0 ? .997 : .001]))
        : { [state.moves()[0]]: 1 };
      return [priors, 0];
    },
    async evaluateBatch(states) {
      batches.push(states.map((state) => state.pos[0]));
      return Promise.all(states.map((state) => this.evaluate(state)));
    },
  };
  const agent = new SigmaBatchAgent(net, { sims: choices.length, batch: choices.length });
  assert.ok(choices.includes(await agent.choose(opening)));
  assert.equal(agent.lastSims, choices.length);
  assert.deepEqual(batches, [choices]);
});
