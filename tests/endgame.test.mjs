import assert from "node:assert/strict";
import test from "node:test";
import { State } from "../rules.js";
import { exactEndgame, proveTwoWallWin } from "../endgame.js";
import { DetourAgent } from "../detour.js";

// From a balanced-opening match against the offline Expert opponent.
const twoWallLine = [
  67, 13, 58, 22, 49, 31, 121, 101, 123, 180, 125, 32, 127, 96, 144, 33,
  175, 198, 118, 24, 104, 33, 173, 24, 40, 129, 31, 23, 30, 22, 21, 20, 12, 83, 13,
  85, 14, 158, 13, 29, 12, 30, 11, 154, 20, 31, 29, 40,
];

const replay = [
  67, 13, 58, 22, 49, 31, 124, 99, 126, 181, 128, 97, 172, 101, 179, 174,
  106, 119, 129, 96, 131, 94, 133, 92, 40, 49, 31, 48, 32, 39, 41, 30, 50,
  29, 51, 28, 52, 27, 53, 36, 44, 45, 43, 46, 34, 55, 186, 46, 25,
];

test("one remaining wall can turn a lost pawn race into a forced win", () => {
  const state = replay.reduce((position, action) => {
    assert.ok(position.legal().includes(action));
    return position.doAction(action);
  }, State.new());
  assert.deepEqual(state.walls, [0, 1]);
  const race = state.clone();
  race.walls[1] = 0;
  assert.equal(exactEndgame(race).outcome, -1);
  assert.deepEqual(exactEndgame(state), { action: 167, outcome: 1, distance: 21 });
  const agent = new DetourAgent({ ms: 1 });
  assert.equal(agent.choose(state), 167);
  assert.equal(agent.stats.endgame, true);

  state.ply = 200;
  assert.deepEqual(exactEndgame(state), { action: 167, outcome: 1, distance: 21 });
});

test("a short forced win with a wall in each hand survives every legal defence", () => {
  const state = twoWallLine.reduce((position, action) => {
    assert.ok(position.legal().includes(action));
    return position.doAction(action);
  }, State.new());
  assert.deepEqual(state.walls, [1, 1]);
  assert.equal(proveTwoWallWin(state, 0), null);
  assert.deepEqual(proveTwoWallWin(state, 2000), { action: 28, outcome: 1, distance: 9 });
});
