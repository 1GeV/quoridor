// Quoridor 9x9 rules engine, plain ES module, no dependencies.
// Mirrors the desktop Python engine (quoridor/rules.py) action for action:
//   pawn moves     0..80   = r * 9 + c
//   horizontal wall 81..144 = 81 + r * 8 + c   (between rows r and r+1)
//   vertical wall  145..208 = 145 + r * 8 + c  (between columns c and c+1)
export const N = 9;
export const NW = 8;
export const N_MOVES = 81;
export const A_H = 81;
export const A_V = 145;

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const idx = (r, c) => r * 8 + c;

export function actionStr(a) {
  if (a < N_MOVES) {
    const r = Math.floor(a / 9), c = a % 9;
    return String.fromCharCode(97 + c) + (r + 1);
  }
  if (a < A_V) {
    const t = a - A_H, r = Math.floor(t / 8), c = t % 8;
    return "H " + String.fromCharCode(97 + c) + (r + 1);
  }
  const t = a - A_V, r = Math.floor(t / 8), c = t % 8;
  return "V " + String.fromCharCode(97 + c) + (r + 1);
}

export function stepOk(hw, vw, r, c, dr, dc) {
  const wrow = r < NW ? r : NW - 1;
  const wcol = c < NW ? c : NW - 1;
  if (dr === -1) return !hw[idx(r - 1, wcol)] && (c === 0 || !hw[idx(r - 1, c - 1)]);
  if (dr === 1) return !hw[idx(r, wcol)] && (c === 0 || !hw[idx(r, c - 1)]);
  if (dc === 1) return !vw[idx(wrow, c)] && (r === 0 || !vw[idx(r - 1, c)]);
  if (dc === -1) return !vw[idx(wrow, c - 1)] && (r === 0 || !vw[idx(r - 1, c - 1)]);
  return false;
}

export function distMap(hw, vw, goalRow) {
  const dist = new Int16Array(81).fill(-1);
  const qr = new Int8Array(81), qc = new Int8Array(81);
  let head = 0, tail = 0;
  for (let c = 0; c < 9; c++) { dist[goalRow * 9 + c] = 0; qr[tail] = goalRow; qc[tail] = c; tail++; }
  while (head < tail) {
    const r = qr[head], c = qc[head]; head++;
    const d = dist[r * 9 + c] + 1;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (dist[nr * 9 + nc] >= 0) continue;
      if (!stepOk(hw, vw, r, c, dr, dc)) continue;
      dist[nr * 9 + nc] = d; qr[tail] = nr; qc[tail] = nc; tail++;
    }
  }
  return dist;
}

function blockingSlots(r, c, dr, dc) {
  const out = [];
  if (dr === -1) { for (const cc of [c - 1, c]) if (cc >= 0 && cc < NW) out.push(A_H + (r - 1) * 8 + cc); }
  else if (dr === 1) { for (const cc of [c - 1, c]) if (cc >= 0 && cc < NW) out.push(A_H + r * 8 + cc); }
  else if (dc === 1) { for (const rr of [r - 1, r]) if (rr >= 0 && rr < NW) out.push(A_V + rr * 8 + c); }
  else { for (const rr of [r - 1, r]) if (rr >= 0 && rr < NW) out.push(A_V + rr * 8 + (c - 1)); }
  return out;
}

function shortestPathSlots(hw, vw, pos, dmap) {
  const slots = new Set();
  let r = Math.floor(pos / 9), c = pos % 9;
  if (dmap[pos] < 0) return slots;
  while (dmap[r * 9 + c] > 0) {
    let moved = false;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (dmap[nr * 9 + nc] !== dmap[r * 9 + c] - 1) continue;
      if (!stepOk(hw, vw, r, c, dr, dc)) continue;
      for (const s of blockingSlots(r, c, dr, dc)) slots.add(s);
      r = nr; c = nc; moved = true; break;
    }
    if (!moved) break;
  }
  return slots;
}

export class State {
  constructor(pos, walls, hw, vw, turn = 0, ply = 0, winner = null) {
    this.pos = pos; this.walls = walls; this.hw = hw; this.vw = vw;
    this.turn = turn; this.ply = ply; this.winner = winner;
    this._d0 = null; this._d1 = null;
  }

  static new() {
    return new State([8 * 9 + 4, 4], [10, 10], new Uint8Array(64), new Uint8Array(64));
  }

  clone() {
    return new State(this.pos.slice(), this.walls.slice(), this.hw.slice(), this.vw.slice(),
      this.turn, this.ply, this.winner);
  }

  distances() {
    if (this._d0 === null) {
      this._d0 = distMap(this.hw, this.vw, 0);
      this._d1 = distMap(this.hw, this.vw, 8);
    }
    return [this._d0, this._d1];
  }

  dist(p) { return this.distances()[p][this.pos[p]]; }

  moves(player = null) {
    const p = player === null ? this.turn : player;
    const r = Math.floor(this.pos[p] / 9), c = this.pos[p] % 9;
    const or = Math.floor(this.pos[1 - p] / 9), oc = this.pos[1 - p] % 9;
    const res = [];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (!stepOk(this.hw, this.vw, r, c, dr, dc)) continue;
      if (nr !== or || nc !== oc) { res.push(nr * 9 + nc); continue; }
      const jr = nr + dr, jc = nc + dc;
      if (jr >= 0 && jr < 9 && jc >= 0 && jc < 9 && stepOk(this.hw, this.vw, nr, nc, dr, dc)) {
        res.push(jr * 9 + jc);
      } else {
        const perp = dr === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
        for (const [pr, qc] of perp) {
          const tr = nr + pr, tc = nc + qc;
          if (tr >= 0 && tr < 9 && tc >= 0 && tc < 9 && stepOk(this.hw, this.vw, nr, nc, pr, qc)) {
            res.push(tr * 9 + tc);
          }
        }
      }
    }
    return res;
  }

  keepsPath(kind, r, c) {
    if (kind === "H") this.hw[idx(r, c)] = 1; else this.vw[idx(r, c)] = 1;
    const d0 = distMap(this.hw, this.vw, 0)[this.pos[0]];
    const d1 = distMap(this.hw, this.vw, 8)[this.pos[1]];
    if (kind === "H") this.hw[idx(r, c)] = 0; else this.vw[idx(r, c)] = 0;
    return d0 >= 0 && d1 >= 0;
  }

  *wallSlots() {
    for (let r = 0; r < NW; r++) {
      for (let c = 0; c < NW; c++) {
        if (this.hw[idx(r, c)] || this.vw[idx(r, c)]) continue;
        if ((c > 0 && this.hw[idx(r, c - 1)]) || (c < NW - 1 && this.hw[idx(r, c + 1)])) continue;
        yield A_H + idx(r, c);
      }
    }
    for (let r = 0; r < NW; r++) {
      for (let c = 0; c < NW; c++) {
        if (this.vw[idx(r, c)] || this.hw[idx(r, c)]) continue;
        if ((r > 0 && this.vw[idx(r - 1, c)]) || (r < NW - 1 && this.vw[idx(r + 1, c)])) continue;
        yield A_V + idx(r, c);
      }
    }
  }

  wallsLegal(player = null) {
    const p = player === null ? this.turn : player;
    if (this.walls[p] <= 0) return [];
    const [d0, d1] = this.distances();
    const hot = new Set([
      ...shortestPathSlots(this.hw, this.vw, this.pos[0], d0),
      ...shortestPathSlots(this.hw, this.vw, this.pos[1], d1),
    ]);
    const out = [];
    for (const a of this.wallSlots()) {
      const vertical = a >= A_V;
      const slot = a - (vertical ? A_V : A_H);
      if (!hot.has(a) || this.keepsPath(vertical ? "V" : "H", slot >> 3, slot % 8)) out.push(a);
    }
    return out;
  }

  legal() { return this.moves().concat(this.wallsLegal()); }

  get terminal() { return this.winner !== null; }

  doAction(a) {
    const s = this.clone();
    const p = s.turn;
    if (a < N_MOVES) {
      s.pos[p] = a;
      if (Math.floor(a / 9) === [0, 8][p]) s.winner = p;
    } else if (a < A_V) {
      const t = a - A_H;
      s.hw[idx(Math.floor(t / 8), t % 8)] = 1;
      s.walls[p] -= 1;
    } else {
      const t = a - A_V;
      s.vw[idx(Math.floor(t / 8), t % 8)] = 1;
      s.walls[p] -= 1;
    }
    s.ply += 1;
    s.turn = 1 - p;
    return s;
  }
}

export { blockedByWallAt };

function blockedByWallAt(hw, vw, kind, r, c) {
  return kind === "H" ? hw[idx(r, c)] === 1 : vw[idx(r, c)] === 1;
}

// A pawn can reach its goal in one turn only from one or two rows away.
export function winningMove(state, player = state.turn) {
  const goal = player === 0 ? 0 : 8;
  const row = Math.floor(state.pos[player] / 9);
  if (Math.abs(row - goal) > 2) return undefined;
  return state.moves(player).find((action) => Math.floor(action / 9) === goal);
}

// Search engines use this at the root so a search limit or a low prior
// cannot hide the only defence against a pawn move that wins immediately.
export function oneTurnDefences(state) {
  const opponent = 1 - state.turn;
  const goal = opponent === 0 ? 0 : 8;
  if (Math.abs(Math.floor(state.pos[opponent] / 9) - goal) > 2) return null;
  const legal = state.legal();
  const safe = legal.filter((action) => {
    const child = state.doAction(action);
    return child.terminal || winningMove(child) === undefined;
  });
  return safe.length && safe.length < legal.length ? new Set(safe) : null;
}
