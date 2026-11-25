// Rules tests for the web engine: parity checks with the Python reference.
import test from "node:test";
import assert from "node:assert/strict";
import { State, actionStr, A_H, A_V } from "../rules.js";

test("opening position: 3 pawn moves + 128 walls", () => {
  const s = State.new();
  assert.equal(s.legal().length, 3 + 128);
  assert.equal(s.dist(0), 8);
  assert.equal(s.dist(1), 8);
  assert.deepEqual([...s.moves()].sort((a, b) => a - b), [67, 75, 77]);
});

test("no legal wall may disconnect either player", () => {
  const rnd = mulberry32(7);
  for (let g = 0; g < 60; g++) {
    let s = State.new();
    for (let ply = 0; ply < 40 && !s.terminal; ply++) {
      const legal = s.legal();
      for (const a of legal) {
        const n = s.doAction(a);
        assert.ok(n.dist(0) >= 0, "player 0 sealed by " + actionStr(a));
        assert.ok(n.dist(1) >= 0, "player 1 sealed by " + actionStr(a));
      }
      s = s.doAction(legal[Math.floor(rnd() * legal.length)]);
    }
  }
});

test("wall overlap and crossing rules", () => {
  const s = State.new();
  s.hw[7 * 8 + 3] = 1;                        // H wall at (7,3)
  const walls = s.wallsLegal();
  assert.ok(!walls.includes(A_H + 7 * 8 + 2), "adjacent H wall must be rejected");
  assert.ok(!walls.includes(A_H + 7 * 8 + 4), "adjacent H wall must be rejected");
  assert.ok(!walls.includes(A_V + 7 * 8 + 3), "crossing V wall must be rejected");
});

test("jump over the opponent, and side step when the jump is walled", () => {
  let s = State.new();
  s.pos = [8 * 9 + 4, 7 * 9 + 4];             // red e9, blue e8 above it
  s.turn = 0;
  assert.deepEqual([...s.moves()].sort((a, b) => a - b), [58, 75, 77]);

  s = State.new();
  s.pos = [8 * 9 + 4, 7 * 9 + 4];
  s.turn = 0;
  s.hw[6 * 8 + 3] = 1;                        // wall behind blue: blocks e7
  s.hw[6 * 8 + 4] = 1;
  const moves = [...s.moves()].sort((a, b) => a - b);
  // jump is walled off: the pawn may sidestep beside the opponent, or step
  // sideways on its own row - four options, no diagonal jump
  assert.deepEqual(moves, [66, 68, 75, 77]);
});

test("a finished race is detected", () => {
  const s = State.new();
  s.pos = [0 * 9 + 4, 8 * 9 + 4];
  s.turn = 0;
  assert.equal(s.doAction(0 * 9 + 3).winner, 0);
});

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


test("repeating positions and passing move 200 leave the game playable", () => {
  let state = State.new();
  for (let i = 0; i < 52; i++) {
    for (const action of [75, 3, 76, 4]) {
      assert.ok(state.legal().includes(action));
      state = state.doAction(action);
      assert.equal(state.terminal, false);
    }
  }
  assert.equal(state.ply, 208);
  state.pos = [13, 21];
  assert.equal(state.doAction(4).winner, 0);
});
