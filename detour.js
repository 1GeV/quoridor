import { Engine } from "./vendor/detour/engine.js";
import { exactEndgame, proveTwoWallWin } from "./endgame.js";
import { A_H, A_V, oneTurnDefences, winningMove } from "./rules.js";

// Position identity for repetition-aware move ordering. Move count is excluded;
// pawns, side to move, reserves, and every wall are included.
export function positionKey(state) {
  let key = String.fromCharCode(state.turn, ...state.pos, ...state.walls);
  for (let i = 0; i < 64; i += 4) {
    let byte = 0;
    for (let j = 0; j < 4; j++) byte |= (state.hw[i + j] + 2 * state.vw[i + j]) << (j * 2);
    key += String.fromCharCode(byte);
  }
  return key;
}

function enginePosition(state) {
  const hWalls = [], vWalls = [];
  for (let index = 0; index < 64; index++) {
    const row = index >> 3, col = index % 8;
    if (state.hw[index]) hWalls.push(`${row},${col}`);
    if (state.vw[index]) vWalls.push(`${row},${col}`);
  }
  return Engine.fromRules({
    rows: 9, cols: 9,
    pawns: Array.from(state.pos, (cell) => ({ r: Math.floor(cell / 9), c: cell % 9 })),
    walls: state.walls, hWalls, vWalls, turn: state.turn, winner: state.winner,
  });
}

function actionId(move) {
  if (move === Engine.MOVE_NONE) return null;
  const index = Engine.mvIndex(move);
  if (!Engine.mvKind(move)) return index;
  return index + (Engine.mvOrient(move) ? A_V : A_H);
}

export class DetourAgent {
  constructor({ maxDepth = 16, ms = 1200 } = {}) {
    this.maxDepth = maxDepth;
    this.ms = ms;
    this.stats = { depth: 0, score: 0, nodes: 0, ms: 0 };
    this.seen = new Map();
  }

  choose(state, { policy, policyWeight, ms = this.ms, seen: previous = null } = {}) {
    if (state.terminal) return null;
    const started = performance.now();
    const seen = previous ? new Map(previous) : new Map(this.seen);
    const currentKey = positionKey(state);
    if (!previous) seen.set(currentKey, (seen.get(currentKey) ?? 0) + 1);
    else if (!seen.has(currentKey)) seen.set(currentKey, 1);
    this.seen = seen;
    const endgame = exactEndgame(state, { seen }) ??
      proveTwoWallWin(state, Math.min(110, ms * 0.08));
    if (endgame) {
      this.stats = { ...endgame, depth: 0, score: endgame.outcome * Engine.WIN, nodes: 0,
        ms: Math.round(performance.now() - started), endgame: true };
      const action = avoidRecentRepeat(state, endgame.action, null, seen);
      this.stats.repeatAvoided = action !== endgame.action;
      return action;
    }
    const win = winningMove(state);
    if (win !== undefined) {
      this.stats = { depth: 1, score: Engine.WIN, nodes: 0, ms: 0 };
      return win;
    }
    const legal = state.legal();
    const defences = oneTurnDefences(state);
    const position = enginePosition(state);
    const result = Engine.analyse(position, {
      maxDepth: this.maxDepth,
      budgetMs: Math.max(1, ms - (performance.now() - started)),
      maxNodes: Math.max(20_000, ms * 900),
      rootAll: true,
      rootAllowed: defences && ((move) => defences.has(actionId(move))),
      rootPolicy: policy && ((move) => policy[actionId(move)]),
      policyWeight,
    });
    this.stats = { depth: result.depth, score: result.score, nodes: result.nodes, ms: Math.round(performance.now() - started) };
    const searchedAction = actionId(result.best);
    const action = avoidRecentRepeat(state, searchedAction, result, seen);
    this.stats.repeatAvoided = action !== searchedAction;
    if (legal.includes(action) && (!defences || defences.has(action))) return action;
    if (defences) {
      let safest = defences.values().next().value, bestScore = -Infinity;
      for (const { move, score } of result.moves) {
        const candidate = actionId(move);
        if (score > bestScore && defences.has(candidate)) { safest = candidate; bestScore = score; }
      }
      return safest;
    }
    return legal[0];
  }
}

function avoidRecentRepeat(state, best, result, seen) {
  if (best == null || (seen.get(positionKey(state.doAction(best))) ?? 0) === 0) return best;
  const bestScore = result?.moves?.find((move) => actionId(move.move) === best)?.score ?? result?.score;
  if (!Number.isFinite(bestScore)) return best;
  const alternatives = (result?.moves || []).filter((move) => {
    const action = actionId(move.move);
    return action != null && Number.isFinite(move.score) && move.score >= bestScore - 80 &&
      (seen.get(positionKey(state.doAction(action))) ?? 0) === 0;
  }).sort((a, b) => b.score - a.score);
  return alternatives.length ? actionId(alternatives[0].move) : best;
}
