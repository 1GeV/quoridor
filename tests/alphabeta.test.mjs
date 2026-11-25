// Legality + speed checks for the alpha-beta engine.
import test from "node:test";
import assert from "node:assert/strict";
import { State } from "../rules.js";
import { AlphaBetaAgent } from "../alphabeta.js";

function randomGame(seed, maxPly = 90) {
  const rng = (() => { let a = seed; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  let s = State.new();
  while (!s.terminal && s.ply < maxPly) {
    const legal = s.legal();
    const pick = legal[Math.floor(rng() * legal.length)];
    s = s.doAction(pick);
  }
  return s;
}

test("engine returns legal actions in real games", () => {
  for (let g = 0; g < 4; g++) {
    let s = randomGame(1000 + g, 60);
    if (s.terminal) continue;
    const agent = new AlphaBetaAgent({ maxDepth: 4, ms: 500, nodes: 20000 });
    for (let i = 0; i < 12 && !s.terminal; i++) {
      const a = agent.choose(s);
      assert.ok(s.legal().includes(a), `illegal action ${a} at ply ${s.ply}`);
      s = s.doAction(a);
    }
  }
});

test("no walls left means only pawn moves", () => {
  let s = State.new();
  // burn all walls quickly by playing wall placements where possible
  while (s.walls[0] > 0 && s.ply < 60) {
    const walls = s.legal().filter((a) => a >= 81);
    s = s.doAction(walls.length ? walls[0] : s.legal()[0]);
  }
  if (!s.terminal && s.turn === 0) {
    const agent = new AlphaBetaAgent({ maxDepth: 4, ms: 500, nodes: 20000 });
    const a = agent.choose(s);
    assert.ok(a < 81, `expected a move, got ${a}`);
  }
});

test("depth scaling and nodes/sec", () => {
  let s = State.new();
  for (const a of [58, 13, 103, 62, 158, 46]) s = s.doAction(a);
  for (const cfg of [
    { maxDepth: 4, ms: 2000, nodes: 1e9 },
    { maxDepth: 5, ms: 4000, nodes: 1e9 },
    { maxDepth: 6, ms: 6000, nodes: 1e9 },
  ]) {
    const agent = new AlphaBetaAgent(cfg);
    const t0 = Date.now();
    const a = agent.choose(s);
    const ms = Date.now() - t0;
    assert.ok(s.legal().includes(a));
    console.log(`      depth ${agent.stats.depth}  nodes ${agent.stats.nodes}  ${ms} ms  ` +
      `${Math.round(agent.stats.nodes / (ms / 1000) / 1000)}k nps  score ${agent.stats.score}  move ${a}`);
  }
});

test("the search key distinguishes wall reserves and ignores the move count", async () => {
  const { probe } = await import("../alphabeta.js");
  const state = State.new();
  const before = probe(state);
  const later = state.clone();
  later.ply++;
  assert.equal(probe(later).key, before.key);
  later.walls[0]--;
  assert.notEqual(probe(later).key, before.key);
});

test("wall-heavy positions use the same distances as the rules engine", async () => {
  const { probe } = await import("../alphabeta.js");
  const agent = new AlphaBetaAgent({ maxDepth: 4 });
  for (let seed = 1; seed <= 20; seed++) {
    const state = randomGame(seed, 25);
    const action = agent.choose(state);
    assert.ok(state.legal().includes(action));
    for (const position of [state, state.doAction(action)]) {
      const distances = probe(position);
      assert.deepEqual([distances.d0, distances.d1], [position.dist(0), position.dist(1)]);
    }
  }
});

test("Alpha-beta blocks an immediate loss at minimal depth", () => {
  const state = State.new();
  state.pos = [49, 67];
  assert.ok([140, 141].includes(new AlphaBetaAgent({ maxDepth: 1 }).choose(state)));
});
