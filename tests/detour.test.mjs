import test from "node:test";
import assert from "node:assert/strict";
import { State, oneTurnDefences } from "../rules.js";
import { searchGuided } from "../guided.js";
import { DetourAgent, positionKey } from "../detour.js";
import { exactEndgame } from "../endgame.js";

test("Detour plays legal moves in both seats and leaves the position unchanged", () => {
  let state = State.new();
  for (const action of [67, 13, 117, 22, 151, 21]) {
    assert.ok(state.legal().includes(action));
    state = state.doAction(action);
  }
  const agent = new DetourAgent({ maxDepth: 3, ms: 100 });
  for (let i = 0; i < 12; i++) {
    const legal = state.legal();
    const snapshot = state.clone();
    const action = agent.choose(state);
    assert.ok(legal.includes(action));
    assert.deepEqual(state.clone(), snapshot);
    state = state.doAction(action);
    if (state.terminal) break;
  }
});

test("Detour avoids a just-repeated tied position without making repetition illegal", () => {
  const state = State.new();
  state.pos = [9, 0];
  state.walls = [0, 0];
  state.turn = 1;
  const preferred = exactEndgame(state).action;
  const seen = new Map([[positionKey(state.doAction(preferred)), 1]]);
  const alternative = exactEndgame(state, { seen }).action;
  assert.notEqual(alternative, preferred);
  const agent = new DetourAgent({ maxDepth: 3, ms: 100 });
  const action = agent.choose(state, { seen });
  assert.ok(state.legal().includes(action));
  assert.equal(action, alternative);

  const trapped = new Map(state.legal().map((move) => [positionKey(state.doAction(move)), 1]));
  const fallback = new DetourAgent({ maxDepth: 2, ms: 50 }).choose(state, { seen: trapped });
  assert.ok(state.legal().includes(fallback));
});

test("Detour adapter handles defence, exact endings past move 200", () => {
  const agent = new DetourAgent({ maxDepth: 3, ms: 100 });
  const state = State.new();
  state.pos = [49, 67];
  assert.ok([140, 141].includes(agent.choose(state)));

  state.pos = [22, 13];
  state.walls = [0, 0];
  state.ply = 199;
  assert.equal(agent.choose(state), 4);
  assert.equal(state.doAction(4).winner, 0);
  assert.equal(agent.choose(state.doAction(4)), null);

  state.pos = [76, 4];
  state.walls = [2, 4];
  const action = agent.choose(state);
  assert.ok(state.legal().includes(action));
  assert.equal(state.doAction(action).terminal, false);
});


test("Guided search forwards policy and keeps immediate defences legal", async () => {
  const state = State.new();
  state.pos = [49, 67];
  const safe = oneTurnDefences(state);
  const unsafe = state.legal().find((action) => !safe.has(action));
  const policy = { [unsafe]: 1 };
  const engine = new DetourAgent({ maxDepth: 5, ms: 100 });
  const result = await searchGuided(state, {
    ms: 100,
    loadNet: () => ({ evaluate: () => [policy, 0] }),
    search: (options) => {
      assert.equal(options.policy, policy);
      assert.ok(options.ms > 0 && options.ms <= 100);
      return { action: engine.choose(state, options) };
    },
  });
  assert.equal(result.guided, true);
  assert.ok(safe.has(result.action));
});

test("Guided search skips loading in exact endings and falls back when inference fails", async () => {
  const state = State.new();
  let loads = 0;
  const options = {
    ms: 100,
    loadNet: () => {
      loads++;
      return { evaluate() { throw new Error("Inference unavailable"); } };
    },
    search: ({ policy }) => {
      assert.equal(policy, undefined);
      return { action: state.moves()[0] };
    },
  };
  state.walls = [0, 0];
  assert.equal((await searchGuided(state, options)).guided, false);
  assert.equal(loads, 0);
  state.walls = [10, 10];
  assert.equal((await searchGuided(state, options)).guided, false);
  assert.equal(loads, 1);
});

test("Cancelling model inference prevents a Guided search from starting", async () => {
  let cancelled = false;
  const result = await searchGuided(State.new(), {
    ms: 100, cancelled: () => cancelled,
    loadNet: () => ({ evaluate() { cancelled = true; return [{ 67: 1 }, 0]; } }),
    search: () => { throw new Error("Search started after cancellation"); },
  });
  assert.equal(result, null);
});
