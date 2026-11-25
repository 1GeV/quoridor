import { winningMove } from "./rules.js";

const CELLS = 81;
const PAIRS = CELLS * CELLS;
const POSITIONS = 2 * PAIRS;
const cache = new Map();
const keyOf = (red, blue, turn) => turn * PAIRS + red * CELLS + blue;

function isPlayable(red, blue, distances) {
  return red !== blue && red >= 9 && blue < 72 && distances[0][red] >= 0 && distances[1][blue] >= 0;
}

function wallExits(state, owner, distances) {
  const actions = new Int16Array(PAIRS).fill(-1);
  const scores = new Int8Array(PAIRS);
  const plies = new Uint16Array(PAIRS);
  const scratch = state.clone();
  scratch.turn = owner;
  for (const action of state.wallSlots()) {
    const child = scratch.doAction(action);
    const reachable = child.distances();
    // A wall may be legal for some pawn pairs and illegal for others. The
    // post-wall distance maps give that test for every pair at once.
    const table = solveBoard(child);
    for (let red = 9; red < CELLS; red++) for (let blue = 0; blue < 72; blue++) {
      if (!isPlayable(red, blue, distances) || !isPlayable(red, blue, reachable)) continue;
      const pair = red * CELLS + blue;
      const key = keyOf(red, blue, 1 - owner);
      const score = -table.outcome[key], distance = table.plies[key] + 1;
      if (actions[pair] === -1 || score > scores[pair] ||
          (score === scores[pair] && score * (distance - plies[pair]) < 0)) {
        actions[pair] = action;
        scores[pair] = score;
        plies[pair] = distance;
      }
    }
  }
  return { actions, scores, plies };
}

function solveBoard(state, owner = -1) {
  const scratch = state.clone();
  const distances = state.distances();
  const exits = owner < 0 ? null : wallExits(state, owner, distances);
  const outcome = new Int8Array(POSITIONS);
  const plies = new Uint16Array(POSITIONS);
  const remaining = new Uint8Array(POSITIONS);
  const longest = new Uint16Array(POSITIONS);
  const incoming = new Int32Array(POSITIONS).fill(-1);
  const predecessor = new Uint16Array(POSITIONS * 5);
  const next = new Int32Array(predecessor.length);
  // Distance buckets are needed because a wall exit enters an already-solved
  // layer and can have any distance, while pawn goals enter at distance zero.
  const buckets = [[]];
  const enqueue = (distance, entry) => (buckets[distance] ??= []).push(entry);
  let edges = 0;

  for (let red = 0; red < CELLS; red++) for (let blue = 0; blue < CELLS; blue++) {
    if (red === blue || (red < 9 && blue >= 72)) continue;
    scratch.pos[0] = red;
    scratch.pos[1] = blue;
    for (let turn = 0; turn < 2; turn++) {
      const key = keyOf(red, blue, turn);
      const winner = red < 9 ? 0 : blue >= 72 ? 1 : null;
      if (winner !== null) {
        outcome[key] = winner === turn ? 1 : -1;
        enqueue(0, outcome[key] === 1 ? key : ~key);
        continue;
      }
      if (!isPlayable(red, blue, distances)) continue;
      const moves = scratch.moves(turn);
      remaining[key] = moves.length;
      for (const action of moves) {
        const child = turn === 0 ? keyOf(action, blue, 1) : keyOf(red, action, 0);
        predecessor[edges] = key;
        next[edges] = incoming[child];
        incoming[child] = edges++;
      }
      if (turn === owner) {
        const pair = red * CELLS + blue;
        if (exits.actions[pair] < 0) continue;
        const score = exits.scores[pair], distance = exits.plies[pair];
        if (score < 0) longest[key] = distance;
        else remaining[key]++; // A win or draw by wall precludes a forced loss.
        if (score > 0) enqueue(distance, key);
      }
    }
  }

  for (let distance = 0; distance < buckets.length; distance++) {
    const bucket = buckets[distance];
    if (!bucket) continue;
    for (const entry of bucket) {
      const child = entry < 0 ? ~entry : entry;
      const score = entry < 0 ? -1 : 1;
      if (distance > 0) {
        if (outcome[child] !== 0) continue;
        outcome[child] = score;
        plies[child] = distance;
      }
      for (let edge = incoming[child]; edge !== -1; edge = next[edge]) {
        const parent = predecessor[edge];
        if (outcome[parent] !== 0) continue;
        if (score === -1) enqueue(distance + 1, parent);
        else if (--remaining[parent] === 0) enqueue(Math.max(longest[parent], distance + 1), ~parent);
      }
    }
  }
  return { outcome, plies, exits, owner };
}

function layoutKey(state) {
  let key = "";
  for (let i = 0; i < 64; i += 4) {
    let byte = 0;
    for (let j = 0; j < 4; j++) byte |= (state.hw[i + j] + 2 * state.vw[i + j]) << (2 * j);
    key += String.fromCharCode(byte);
  }
  return key;
}

function tableFor(state, cachedOnly = false) {
  const owner = state.walls[0] ? 0 : state.walls[1] ? 1 : -1;
  const key = String(owner) + layoutKey(state);
  let table = cache.get(key);
  if (!table && !cachedOnly) {
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    table = solveBoard(state, owner);
    cache.set(key, table);
  }
  return table;
}

export function raceValue(state, { cachedOnly = false } = {}) {
  if (state.terminal) return state.winner === state.turn ? 1 : -1;
  if (state.walls[0] || state.walls[1]) return null;
  const table = tableFor(state, cachedOnly);
  if (!table) return null;
  const key = keyOf(state.pos[0], state.pos[1], state.turn);
  return table.outcome[key];
}

function repetitionKey(state) {
  let key = String.fromCharCode(state.turn, ...state.pos, ...state.walls);
  for (let i = 0; i < 64; i += 4) {
    let byte = 0;
    for (let j = 0; j < 4; j++) byte |= (state.hw[i + j] + 2 * state.vw[i + j]) << (j * 2);
    key += String.fromCharCode(byte);
  }
  return key;
}

export function exactEndgame(state, { seen } = {}) {
  if (state.terminal || state.walls[0] + state.walls[1] > 1) return null;
  const table = tableFor(state);
  const opponent = 1 - state.turn;
  const distances = state.distances()[state.turn];
  let best = null, score = -Infinity, outcome = 0, distance = 0, repeated = Infinity;
  function consider(action, value, plies, goalDistance, repeatCount) {
    const rank = value === 1 ? 1000 - plies : value === -1 ? -1000 + plies : -goalDistance;
    if (rank > score || (rank === score && repeatCount < repeated)) {
      best = action; score = rank; outcome = value; distance = value ? plies : 0; repeated = repeatCount;
    }
  }
  for (const action of state.moves()) {
    const red = state.turn === 0 ? action : state.pos[0];
    const blue = state.turn === 1 ? action : state.pos[1];
    const key = keyOf(red, blue, opponent);
    const next = state.doAction(action);
    consider(action, -table.outcome[key], table.plies[key] + 1, distances[action], seen?.get(repetitionKey(next)) ?? 0);
  }
  if (state.turn === table.owner) {
    const pair = state.pos[0] * CELLS + state.pos[1];
    const { actions, scores, plies } = table.exits;
    if (actions[pair] >= 0) {
      const next = state.doAction(actions[pair]);
      consider(actions[pair], scores[pair], plies[pair], distances[state.pos[state.turn]], seen?.get(repetitionKey(next)) ?? 0);
    }
  }
  return { action: best, outcome, distance };
}

// Solve short forced wins on the two-wall frontier. An exhausted horizon or
// clock makes this inconclusive, so callers keep their normal search fallback.
export function proveTwoWallWin(state, ms) {
  if (state.terminal || state.walls[0] + state.walls[1] !== 2 || ms <= 0) return null;
  const attacker = state.turn;
  const deadline = performance.now() + ms;
  const memo = new Map();
  const timedOut = Symbol();
  let nodes = 0;

  function wins(position, horizon) {
    if ((++nodes & 31) === 0 && performance.now() >= deadline) throw timedOut;
    if (position.terminal) return position.winner === attacker;
    const attackTurn = position.turn === attacker;
    const turnsLeft = (horizon + Number(attackTurn)) >> 1;
    if (turnsLeft < 1) return false;
    const instant = winningMove(position) !== undefined;
    if (instant) return attackTurn;
    if ((attackTurn && turnsLeft === 1) || position.dist(attacker) > turnsLeft * 2) return false;

    const solved = raceValue(position, { cachedOnly: true });
    if (solved !== null) {
      if (solved !== (attackTurn ? 1 : -1)) return false;
      const table = tableFor(position, true);
      return table.plies[keyOf(...position.pos, position.turn)] <= horizon;
    }

    const key = String.fromCharCode(...position.pos, position.turn, ...position.walls) + layoutKey(position);
    let bounds = memo.get(key);
    if (bounds) {
      if (horizon >= bounds.win) return true;
      if (horizon <= bounds.noWin) return false;
    } else {
      bounds = { win: Infinity, noWin: -1 };
      memo.set(key, bounds);
    }
    const distances = position.distances()[position.turn];
    const moves = position.moves().sort((a, b) => distances[a] - distances[b]);
    // The attacker needs one winning reply; the defender needs every reply
    // to lose. Include quiet and non-shortest-path moves for the exact proof.
    const actions = moves.concat(position.wallsLegal());
    const result = attackTurn
      ? actions.some((action) => wins(position.doAction(action), horizon - 1))
      : actions.every((action) => wins(position.doAction(action), horizon - 1));
    if (result) bounds.win = Math.min(bounds.win, horizon);
    else bounds.noWin = Math.max(bounds.noWin, horizon);
    return result;
  }

  const instant = winningMove(state);
  if (instant !== undefined) return { action: instant, outcome: 1, distance: 1 };
  const distances = state.distances()[attacker];
  const actions = state.moves().sort((a, b) => distances[a] - distances[b]).concat(state.wallsLegal());
  try {
    // A ply on which the defender moves cannot finish an attacker's win.
    for (let distance = 3; distance <= 11 && performance.now() < deadline; distance += 2) {
      for (const action of actions) {
        if (performance.now() >= deadline) return null;
        if (wins(state.doAction(action), distance - 1)) return { action, outcome: 1, distance };
      }
    }
  } catch (error) {
    if (error !== timedOut) throw error;
  }
  return null;
}

export function raceMove(state) {
  return exactEndgame(state)?.action ?? null;
}
