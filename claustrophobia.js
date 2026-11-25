// Claustrophobia v1.3.1 encoder contract (MIT, Plaaasma). See NOTICE.md.
import { A_H, A_V, distMap, stepOk } from "./rules.js";
import { loadModelSession } from "./sigma.js";

const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const CELLS = 81;
const PLANES = 20;
const ACTIONS = 209;
const norm = (x) => x < 0 ? 1 : Math.min(20, x) / 20;

function canonicalAction(action, flip) {
  if (!flip) return action;
  if (action < A_H) return 80 - action;
  const base = action < A_V ? A_H : A_V;
  return base + 63 - (action - base);
}

export function encodeChampion(state) {
  const flip = state.turn === 0; // The checkpoint expects the mover to aim for row 9.
  const turn = state.turn, opponent = 1 - turn;
  const pawns = [state.pos[turn], state.pos[opponent]];
  const distances = state.distances();
  const fields = [distances[turn], distances[opponent]];
  const goals = turn === 0 ? [0, 8] : [8, 0];
  const base = fields.map((field, side) => field[pawns[side]]);
  const threats = fields.map((field) => Float32Array.from(field, norm));
  const tensor = new Float32Array(PLANES * CELLS);
  const setCell = (plane, cell, value) => { tensor[plane * CELLS + (flip ? 80 - cell : cell)] = value; };
  const setSlot = (plane, slot, value) => {
    const at = flip ? 63 - slot : slot;
    tensor[plane * CELLS + Math.floor(at / 8) * 9 + (at % 8)] = value;
  };
  const players = [turn, opponent];
  for (const [side, colour] of players.entries()) {
    setCell(side, pawns[side], 1);
    tensor.fill(state.walls[colour] / 10, (4 + side) * CELLS, (5 + side) * CELLS);
    for (let cell = 0; cell < CELLS; cell++) setCell(7 + side, cell, norm(fields[side][cell]));
    // Traverse all descending shortest edges from the pawn to its goal.
    const visited = new Uint8Array(CELLS);
    const queue = [pawns[side]];
    visited[pawns[side]] = 1;
    for (const cell of queue) {
      setCell(9 + side, cell, 1);
      const row = Math.floor(cell / 9), col = cell % 9;
      for (const [dr, dc] of directions) {
        const next = cell + dr * 9 + dc;
        if (row + dr < 0 || row + dr > 8 || col + dc < 0 || col + dc > 8 || visited[next] ||
            fields[side][next] !== fields[side][cell] - 1 || fields[side][next] < 0 ||
            !stepOk(state.hw, state.vw, row, col, dr, dc)) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  tensor.fill(1, 6 * CELLS, 7 * CELLS);
  tensor.fill(Math.max(-1, Math.min(1, (base[1] - base[0]) / 20)), 13 * CELLS, 14 * CELLS);
  for (let slot = 0; slot < 64; slot++) {
    if (state.hw[slot]) setSlot(2, slot, 1);
    if (state.vw[slot]) setSlot(3, slot, 1);
  }
  const { hw, vw } = state.clone();
  for (const action of state.wallSlots()) {
    const vertical = Number(action >= A_V);
    const slot = action - (vertical ? A_V : A_H);
    const walls = vertical ? vw : hw;
    walls[slot] = 1;
    const own = distMap(hw, vw, goals[0]), opp = distMap(hw, vw, goals[1]);
    walls[slot] = 0;
    if (own[pawns[0]] < 0 || opp[pawns[1]] < 0) continue;
    setSlot(11 + vertical, slot, 1);
    for (const [side, field] of [own, opp].entries()) {
      const delta = field[pawns[side]] - base[side];
      if (delta <= 0) continue;
      const placer = players[1 - side];
      if (state.walls[placer]) setSlot((side === 0 ? 18 : 16) + vertical, slot, Math.min(8, delta) / 8);
      for (let cell = 0; cell < CELLS; cell++) threats[side][cell] = Math.max(threats[side][cell], norm(field[cell]));
    }
  }
  for (const [side, field] of threats.entries()) {
    for (let cell = 0; cell < CELLS; cell++) setCell(14 + side, cell, field[cell]);
  }
  return tensor;
}

export class ClaustrophobiaNet {
  constructor(session) {
    this.session = session;
  }

  static async load(url) {
    return new ClaustrophobiaNet(await loadModelSession(url));
  }

  async evaluate(state) {
    const input = new globalThis.ort.Tensor("float32", encodeChampion(state), [1, PLANES, 9, 9]);
    const { logits, value } = await this.session.run({ x: input }, ["logits", "value"]);
    const legal = state.legal();
    const logit = (action) => logits.data[canonicalAction(action, state.turn === 0)];
    const max = Math.max(...legal.map(logit));
    const policy = new Float32Array(ACTIONS);
    let sum = 0;
    for (const action of legal) {
      policy[action] = Math.exp(logit(action) - max);
      sum += policy[action];
    }
    if (!(sum > 0) || !Number.isFinite(value.data[0])) throw new Error("Invalid Claustrophobia output");
    for (const action of legal) policy[action] /= sum;
    return [policy, value.data[0]];
  }
}
