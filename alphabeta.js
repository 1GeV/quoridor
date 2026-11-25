// Alpha-beta Quoridor engine, plain ES module, no dependencies.
// Iterative deepening with a transposition table. The evaluation combines
// shortest-path lengths and remaining walls. Candidate walls are ordered
// by their immediate route impact.
// Action ids are identical to rules.js (0..80 moves, 81..144 H, 145..208 V).
import { N_MOVES, A_H, A_V, winningMove, oneTurnDefences } from "./rules.js";

import { raceMove } from "./endgame.js";

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const GOAL = [0, 8];
const WIN = 1e6;
const INF = 1e9;

const hw = new Uint8Array(64);
const vw = new Uint8Array(64);
const pos = new Int8Array(2);
const wleft = new Int8Array(2);
let turn = 0;
const MAX_SEARCH_DEPTH = 64;
let ply = 0;
let hash = 0;
let searchKey = 0;
let wallHash = 0;
const wallBits = new Int32Array(4);

// A wall affects exactly two undirected edges. Keeping the open edges in a
// bitmask avoids looking up four potential wall anchors at every BFS step.
const edges = new Uint8Array(81);
const emptyEdges = new Uint8Array(81);
const [UP, DOWN, RIGHT, LEFT] = [1, 2, 4, 8];
for (let cell = 0; cell < 81; cell++) {
  const r = Math.floor(cell / 9), c = cell % 9;
  emptyEdges[cell] = (r > 0 ? UP : 0) | (r < 8 ? DOWN : 0) |
    (c < 8 ? RIGHT : 0) | (c > 0 ? LEFT : 0);
}
const wallCells = Int8Array.from({ length: 64 }, (_, i) => i + (i >> 3));

function toggleWall(isHorizontal, i) {
  const cell = wallCells[i];
  if (isHorizontal) {
    edges[cell] ^= DOWN; edges[cell + 1] ^= DOWN;
    edges[cell + 9] ^= UP; edges[cell + 10] ^= UP;
  } else {
    edges[cell] ^= RIGHT; edges[cell + 9] ^= RIGHT;
    edges[cell + 1] ^= LEFT; edges[cell + 10] ^= LEFT;
  }
}

function loadState(state) {
  pos.set(state.pos);
  wleft.set(state.walls);
  hw.set(state.hw);
  vw.set(state.vw);
  turn = state.turn;
  ply = 0;
  hash = fullHash();
  searchKey = (wleft[0] * 11 + wleft[1]) * 2 ** 32;
  edges.set(emptyEdges);
  wallHash = 0;
  wallBits.fill(0);
  for (let i = 0; i < 64; i++) {
    if (hw[i]) updateWall(true, i);
    if (vw[i]) updateWall(false, i);
  }
}

function updateWall(horizontal, i) {
  toggleWall(horizontal, i);
  wallHash ^= horizontal ? ZH[i] : ZV[i];
  wallBits[(horizontal ? 0 : 2) + (i >> 5)] ^= 1 << (i & 31);
}

const PLY_KEY = 121 * 2 ** 32;
const RESERVE_KEY = [11 * 2 ** 32, 2 ** 32];

// ---------------------------------------------------------------- zobrist
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x9e3779b9);
const ZP = [new Int32Array(81), new Int32Array(81)];
const ZH = new Int32Array(64);
const ZV = new Int32Array(64);
const ZTURN = (rnd() * 4294967296) | 0;
for (let i = 0; i < 81; i++) { ZP[0][i] = (rnd() * 4294967296) | 0; ZP[1][i] = (rnd() * 4294967296) | 0; }
for (let i = 0; i < 64; i++) { ZH[i] = (rnd() * 4294967296) | 0; ZV[i] = (rnd() * 4294967296) | 0; }

function fullHash() {
  let h = 0;
  h ^= ZP[0][pos[0]] ^ ZP[1][pos[1]];
  for (let i = 0; i < 64; i++) { if (hw[i]) h ^= ZH[i]; if (vw[i]) h ^= ZV[i]; }
  if (turn === 1) h ^= ZTURN;
  return h;
}

// ---------------------------------------------------------------- board ops
function stepOk(r, c, dr, dc) {
  return edges[r * 9 + c] & (dr === -1 ? UP : dr === 1 ? DOWN : dc === 1 ? RIGHT : LEFT);
}

const Q = new Int16Array(96);
const DIST = new Int16Array(81);
const MAP_CACHE_SIZE = 2048;
const mapCache = Array.from({ length: MAP_CACHE_SIZE }, () => ({
  valid: false,
  bits: new Int32Array(4),
  maps: [new Int8Array(81), new Int8Array(81)],
}));

// single-source BFS, early exit when a goal-row square is discovered
function bfsDist(p, goalRow) {
  const start = pos[p];
  if ((start / 9 | 0) === goalRow) return 0;
  DIST.fill(-1);
  DIST[start] = 0;
  Q[0] = start;
  let head = 0, tail = 1;
  while (head < tail) {
    const cell = Q[head++];
    const r = cell / 9 | 0, open = edges[cell];
    const d = DIST[cell] + 1;
    // up
    if ((open & UP) && DIST[cell - 9] < 0) {
      if (r - 1 === goalRow) return d;
      DIST[cell - 9] = d; Q[tail++] = cell - 9;
    }
    // down
    if ((open & DOWN) && DIST[cell + 9] < 0) {
      if (r + 1 === goalRow) return d;
      DIST[cell + 9] = d; Q[tail++] = cell + 9;
    }
    // right
    if ((open & RIGHT) && DIST[cell + 1] < 0) {
      DIST[cell + 1] = d; Q[tail++] = cell + 1;
    }
    // left
    if ((open & LEFT) && DIST[cell - 1] < 0) {
      DIST[cell - 1] = d; Q[tail++] = cell - 1;
    }
  }
  return -1;
}

// full distance-to-goal map (BFS seeded from the goal row, like rules.js distMap)
function bfsMap(out, goalRow) {
  out.fill(-1);
  let head = 0, tail = 0;
  for (let c = 0; c < 9; c++) {
    out[goalRow * 9 + c] = 0;
    Q[tail++] = goalRow * 9 + c;
  }
  while (head < tail) {
    const cell = Q[head++];
    const d = out[cell] + 1;
    const open = edges[cell];
    if ((open & UP) && out[cell - 9] < 0) { out[cell - 9] = d; Q[tail++] = cell - 9; }
    if ((open & DOWN) && out[cell + 9] < 0) { out[cell + 9] = d; Q[tail++] = cell + 9; }
    if ((open & RIGHT) && out[cell + 1] < 0) { out[cell + 1] = d; Q[tail++] = cell + 1; }
    if ((open & LEFT) && out[cell - 1] < 0) { out[cell - 1] = d; Q[tail++] = cell - 1; }
  }
  return out;
}

// Pawn moves preserve the wall layout. Reuse its distance maps, verifying
// the full board even if two layouts are assigned to the same cache slot.
function distanceEntry() {
  return mapCache[wallHash & (MAP_CACHE_SIZE - 1)];
}

function mapsMatch(entry) {
  const bits = entry.bits;
  return entry.valid && bits[0] === wallBits[0] && bits[1] === wallBits[1] &&
    bits[2] === wallBits[2] && bits[3] === wallBits[3];
}

function boardMaps() {
  const entry = distanceEntry();
  if (!mapsMatch(entry)) {
    entry.bits.set(wallBits);
    bfsMap(entry.maps[0], 0);
    bfsMap(entry.maps[1], 8);
    entry.valid = true;
  }
  return entry.maps;
}

function apply(a) {
  const p = turn;
  const old = pos[p];
  hash ^= ZTURN;
  if (a < N_MOVES) {
    hash ^= ZP[p][old] ^ ZP[p][a];
    pos[p] = a;
  } else if (a < A_V) {
    const i = a - A_H;
    hw[i] = 1; wleft[p]--; hash ^= ZH[i]; updateWall(true, i);
  } else {
    const i = a - A_V;
    vw[i] = 1; wleft[p]--; hash ^= ZV[i]; updateWall(false, i);
  }
  searchKey += PLY_KEY - (a >= N_MOVES ? RESERVE_KEY[p] : 0);
  ply++; turn = 1 - p;
  return old;
}

function unapply(a, old) {
  turn = 1 - turn; ply--;
  const p = turn;
  searchKey -= PLY_KEY - (a >= N_MOVES ? RESERVE_KEY[p] : 0);
  hash ^= ZTURN;
  if (a < N_MOVES) {
    hash ^= ZP[p][pos[p]] ^ ZP[p][old];
    pos[p] = old;
  } else if (a < A_V) {
    const i = a - A_H;
    hw[i] = 0; wleft[p]++; hash ^= ZH[i]; updateWall(true, i);
  } else {
    const i = a - A_V;
    vw[i] = 0; wleft[p]++; hash ^= ZV[i]; updateWall(false, i);
  }
}

// ---------------------------------------------------------------- generation
const MVP = [];
const MSP = [];
for (let i = 0; i <= MAX_SEARCH_DEPTH; i++) { MVP.push(new Int16Array(240)); MSP.push(new Int32Array(240)); }

function pawnMoves(p, out, n) {
  const r = pos[p] / 9 | 0, c = pos[p] % 9;
  const or = pos[1 - p] / 9 | 0, oc = pos[1 - p] % 9;
  for (const [dr, dc] of DIRS) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
    if (!stepOk(r, c, dr, dc)) continue;
    if (nr !== or || nc !== oc) { out[n++] = nr * 9 + nc; continue; }
    const jr = nr + dr, jc = nc + dc;
    if (jr >= 0 && jr < 9 && jc >= 0 && jc < 9 && stepOk(nr, nc, dr, dc)) {
      out[n++] = jr * 9 + jc;
    } else {
      const perp = dr === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
      for (const [pr, pc] of perp) {
        const tr = nr + pr, tc = nc + pc;
        if (tr >= 0 && tr < 9 && tc >= 0 && tc < 9 && stepOk(nr, nc, pr, pc)) out[n++] = tr * 9 + tc;
      }
    }
  }
  return n;
}

const hot0 = new Uint8Array(209);
const hot1 = new Uint8Array(209);

function markPath(p, map, hot) {
  let cell = pos[p];
  const goalRow = GOAL[p];
  if (map[cell] < 0) return;
  let guard = 0;
  while ((cell / 9 | 0) !== goalRow && guard++ < 90) {
    const r = cell / 9 | 0, c = cell % 9;
    const d = map[cell];
    let next = -1;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (map[nr * 9 + nc] !== d - 1) continue;
      if (!stepOk(r, c, dr, dc)) continue;
      if (dr === -1) { for (const cc of [c - 1, c]) if (cc >= 0 && cc < 8) hot[A_H + (r - 1) * 8 + cc] = 1; }
      else if (dr === 1) { for (const cc of [c - 1, c]) if (cc >= 0 && cc < 8) hot[A_H + r * 8 + cc] = 1; }
      else if (dc === 1) { for (const rr of [r - 1, r]) if (rr >= 0 && rr < 8) hot[A_V + rr * 8 + c] = 1; }
      else { for (const rr of [r - 1, r]) if (rr >= 0 && rr < 8) hot[A_V + rr * 8 + c - 1] = 1; }
      next = nr * 9 + nc;
      break;
    }
    if (next < 0) break;
    cell = next;
  }
}

// Wall test: is it legal, and how much does it change the race?
// Returns -INF for illegal, else gain in centi-steps (opponent slow-down minus own slow-down).
function wallGain(a, d0, d1) {
  const isH = a < A_V;
  const i = isH ? a - A_H : a - A_V;
  toggleWall(isH, i);
  const old0 = d0[pos[0]], old1 = d1[pos[1]];
  let n0 = old0, n1 = old1;
  let ok = true;
  // If a wall misses one known shortest path, that path still exists.
  if (hot0[a]) { n0 = bfsDist(0, 0); if (n0 < 0) ok = false; }
  if (ok && hot1[a]) { n1 = bfsDist(1, 8); if (n1 < 0) ok = false; }
  toggleWall(isH, i);
  if (!ok) return -INF;
  const me = turn, op = 1 - turn;
  const nMe = me === 0 ? n0 : n1, oMe = me === 0 ? old0 : old1;
  const nOp = op === 0 ? n0 : n1, oOp = op === 0 ? old0 : old1;
  return (nOp - oOp) * 100 - (nMe - oMe) * 100;
}

const TOPA = new Int16Array(48);
const TOPS = new Int32Array(48);
const TOPN = new Int16Array(1);
const KILL = [];
for (let i = 0; i < MAX_SEARCH_DEPTH; i++) KILL.push([-1, -1]);
const HIST = new Int32Array(2 * 209);

function pushTop(a, s, K) {
  let n = TOPN[0];
  if (n < K) {
    let i = n++;
    TOPA[i] = a; TOPS[i] = s;
    while (i > 0 && TOPS[i - 1] < TOPS[i]) {
      const ta = TOPA[i - 1], ts = TOPS[i - 1];
      TOPA[i - 1] = TOPA[i]; TOPS[i - 1] = TOPS[i]; TOPA[i] = ta; TOPS[i] = ts; i--;
    }
    TOPN[0] = n;
  } else if (s > TOPS[K - 1]) {
    TOPA[K - 1] = a; TOPS[K - 1] = s;
    let i = K - 1;
    while (i > 0 && TOPS[i - 1] < TOPS[i]) {
      const ta = TOPA[i - 1], ts = TOPS[i - 1];
      TOPA[i - 1] = TOPA[i]; TOPS[i - 1] = TOPS[i]; TOPA[i] = ta; TOPS[i] = ts; i--;
    }
  }
}

function genMoves(d0, d1, K, ttMove, outA, outS) {
  const me = turn;
  const dMe = me === 0 ? d0 : d1;
  let n = pawnMoves(me, outA, 0);
  const k0 = KILL[Math.min(ply, MAX_SEARCH_DEPTH - 1)][0];
  const k1 = KILL[Math.min(ply, MAX_SEARCH_DEPTH - 1)][1];
  for (let i = 0; i < n; i++) {
    const a = outA[i];
    let sc = (dMe[pos[me]] - dMe[a]) * 100;
    if (a === ttMove) sc = INF / 2;
    else if (a === k0) sc += 700;
    else if (a === k1) sc += 350;
    sc += HIST[me * 209 + a];
    outS[i] = sc;
  }

  TOPN[0] = 0;
  if (wleft[me] > 0) {
    hot0.fill(0); hot1.fill(0);
    markPath(0, d0, hot0);
    markPath(1, d1, hot1);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const i = r * 8 + c;
        if (!hw[i] && !vw[i] && !(c > 0 && hw[i - 1]) && !(c < 7 && hw[i + 1])) {
          const a = A_H + i;
          if (!hotOnly || hot0[a] || hot1[a]) {
            const g = wallGain(a, d0, d1);
            // A wall must actually slow the opponent more than it slows us.
            // The old "accept anything when behind" rule produced visible wall spam.
            if (g >= wallNeed * 100 && (g > 0 || hot0[a] || hot1[a] || a === ttMove)) {
              let sc = g - tempoCost;
              if (a === ttMove) sc = INF / 2;
              else if (a === k0) sc += 700;
              else if (a === k1) sc += 350;
              sc += HIST[me * 209 + a];
              pushTop(a, sc, K);
            }
          }
        }
        if (!vw[i] && !hw[i] && !(r > 0 && vw[i - 8]) && !(r < 7 && vw[i + 8])) {
          const a = A_V + i;
          if (!hotOnly || hot0[a] || hot1[a]) {
            const g = wallGain(a, d0, d1);
            if (g >= wallNeed * 100 && (g > 0 || hot0[a] || hot1[a] || a === ttMove)) {
              let sc = g - tempoCost;
              if (a === ttMove) sc = INF / 2;
              else if (a === k0) sc += 700;
              else if (a === k1) sc += 350;
              sc += HIST[me * 209 + a];
              pushTop(a, sc, K);
            }
          }
        }
      }
    }
  }

  // insertion sort by score desc (move list is short)
  for (let i = 1; i < n; i++) {
    const a = outA[i], s = outS[i];
    let j = i - 1;
    while (j >= 0 && outS[j] < s) { outA[j + 1] = outA[j]; outS[j + 1] = outS[j]; j--; }
    outA[j + 1] = a; outS[j + 1] = s;
  }
  const tn = TOPN[0];
  for (let i = 0; i < tn; i++) {
    outA[n] = TOPA[i];
    outS[n] = TOPS[i];
    n++;
  }
  // re-sort only the appended tail into place
  for (let i = n - tn; i < n; i++) {
    const a = outA[i], s = outS[i];
    let j = i - 1;
    while (j >= 0 && outS[j] < s) { outA[j + 1] = outA[j]; outS[j + 1] = outS[j]; j--; }
    outA[j + 1] = a; outS[j + 1] = s;
  }
  return n;
}

// ---------------------------------------------------------------- search
const ABORT = { abort: true };
const TT = new Map();
let nodes = 0;
let deadline = 0;
let nodeCap = 0;
let wallWeight = 65;
let parityBonus = 0;
let wallNeed = 1;
let tempoCost = 100;
let hotOnly = 0;

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function evaluate() {
  const me = turn, op = 1 - turn;
  const entry = distanceEntry();
  const maps = mapsMatch(entry) ? entry.maps : null;
  const my = maps ? maps[me][pos[me]] : bfsDist(me, GOAL[me]);
  if (my < 0) return -WIN + ply;
  const od = maps ? maps[op][pos[op]] : bfsDist(op, GOAL[op]);
  if (od < 0) return WIN - ply;
  let s = (od - my) * 100 + (wleft[me] - wleft[op]) * wallWeight;
  // equal distances: the side to move reaches the goal first, so it wins the
  // race even though the raw difference is zero.
  if (my === od) s += 100;
  if (parityBonus) s += my <= od ? parityBonus : -parityBonus;
  return s;
}

function negamax(depth, alpha, beta) {
  nodes++;
  if (nodes > nodeCap || ((nodes & 63) === 0 && now() >= deadline)) throw ABORT;
  const key = searchKey + hash;
  const e = TT.get(key);
  let ttMove = -1;
  if (e !== undefined) {
    ttMove = e.m;
    if (e.d >= depth) {
      if (e.f === 0) return e.s;
      if (e.f === 1 && e.s <= alpha) return e.s;
      if (e.f === 2 && e.s >= beta) return e.s;
    }
  }
  if (depth <= 0) return evaluate();

  const [d0, d1] = boardMaps();

  const outA = MVP[depth], outS = MSP[depth];
  const K = depth >= 5 ? 14 : depth >= 3 ? 18 : 24;
  const n = genMoves(d0, d1, K, ttMove, outA, outS);

  const alpha0 = alpha;
  const killers = KILL[Math.min(ply, MAX_SEARCH_DEPTH - 1)];
  let best = -INF, bestMove = outA[0];
  for (let i = 0; i < n; i++) {
    const a = outA[i];
    const mover = turn;
    const old = apply(a);
    let v;
    if (a < N_MOVES && (a / 9 | 0) === GOAL[1 - turn]) {
      v = WIN - ply;
    } else if (i === 0) {
      v = -negamax(depth - 1, -beta, -alpha);
    } else {
      v = -negamax(depth - 1, -alpha - 1, -alpha);
      if (v > alpha && v < beta) v = -negamax(depth - 1, -beta, -alpha);
    }
    unapply(a, old);
    if (v > best) { best = v; bestMove = a; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) {
      if (a >= N_MOVES) {
        if (killers[0] !== a) { killers[1] = killers[0]; killers[0] = a; }
      }
      HIST[mover * 209 + a] += depth * depth;
      break;
    }
  }
  const flag = best <= alpha0 ? 1 : best >= beta ? 2 : 0;
  TT.set(key, { d: depth, s: best, f: flag, m: bestMove });
  return best;
}

// ---------------------------------------------------------------- public
export class AlphaBetaAgent {
  constructor({ maxDepth = 5, ms = 1200, nodes: cap = 40000, margin = 0, seed = 1, wallWeight: ww = 65, parity = 0, need = 1, tempo = 0, hot = 0 } = {}) {
    this.maxDepth = maxDepth;
    this.ms = ms;
    this.cap = cap;
    this.margin = margin;
    this.seed = seed;
    this.wallWeight = ww;
    this.parity = parity;
    this.need = need;
    this.tempo = tempo;
    this.hot = hot;
    this.rng = mulberry32(seed);
    this.stats = { depth: 0, nodes: 0, ms: 0, score: 0 };
  }

  choose(state) {
    if (state.terminal) return null;
    if (!state.walls[0] && !state.walls[1]) {
      const started = now();
      const action = raceMove(state);
      this.stats = { depth: 0, nodes: 0, ms: Math.round(now() - started), score: 0, endgame: true };
      return action;
    }
    const win = winningMove(state);
    if (win !== undefined) {
      this.stats = { depth: 1, nodes: 0, ms: 0, score: WIN - 1 };
      return win;
    }
    const defences = oneTurnDefences(state);
    loadState(state);

    TT.clear();
    nodes = 0;
    HIST.fill(0);
    for (const killers of KILL) killers.fill(-1);
    wallWeight = this.wallWeight;
    parityBonus = this.parity;
    wallNeed = this.need;
    tempoCost = this.tempo;
    hotOnly = this.hot;
    const t0 = now();
    deadline = t0 + this.ms;
    nodeCap = this.cap;

    let bestMove = -1, bestScore = 0, completedDepth = 0;
    let lastList = null;
    for (let d = 1; d <= Math.min(this.maxDepth, MAX_SEARCH_DEPTH); d++) {
      try {
        if (d > 1 && now() >= deadline) break;
        const list = this.rootSearch(d, bestMove, defences);
        lastList = list;
        bestMove = list[0].a;
        bestScore = list[0].s;
        completedDepth = d;
        if (bestScore >= WIN - MAX_SEARCH_DEPTH && this.margin === 0) break;
      } catch (err) {
        if (err !== ABORT) throw err;
        break;
      }
    }
    if (bestMove < 0) bestMove = defences?.values().next().value ?? state.moves()[0];
    this.stats = { depth: completedDepth, nodes, ms: Math.round(now() - t0), score: bestScore };

    if (this.margin > 0 && lastList && lastList.length > 1) {
      const cut = lastList[0].s - this.margin;
      const pool = lastList.filter((x) => x.s >= cut);
      return pool[Math.floor(this.rng() * pool.length)].a;
    }
    return bestMove;
  }

  rootSearch(depth, bestMove, defences) {
    const [d0, d1] = boardMaps();
    const outA = new Int16Array(240), outS = new Int32Array(240);
    let n = genMoves(d0, d1, 32, bestMove, outA, outS);
    if (defences) {
      const ordered = new Set();
      for (let i = 0; i < n; i++) {
        if (defences.has(outA[i])) ordered.add(outA[i]);
      }
      if (ordered.size < 6) {
        for (const action of defences) {
          ordered.add(action);
          if (ordered.size >= 32) break;
        }
      }
      outA.set([...ordered]);
      n = ordered.size;
    }
    const list = [];
    let alpha = -INF;
    for (let i = 0; i < n; i++) {
      const a = outA[i];
      const old = apply(a);
      let v;
      if (a < N_MOVES && (a / 9 | 0) === GOAL[1 - turn]) {
        v = WIN - ply;
      } else if (i === 0 || this.margin > 0) {
        v = -negamax(depth - 1, -INF, INF);
      } else {
        v = -negamax(depth - 1, -alpha - 1, -alpha);
        if (v > alpha) v = -negamax(depth - 1, -INF, INF);
      }
      unapply(a, old);
      list.push({ a, s: v });
      if (v > alpha) alpha = v;
    }
    list.sort((x, y) => y.s - x.s);
    return list;
  }
}

export function legalAction(state, a) {
  return state.legal().includes(a);
}

// Debug helper: expose internal distances so tests can compare with rules.js.
export function probe(state) {
  loadState(state);
  const [m0, m1] = boardMaps();
  return { key: searchKey + hash, d0: m0[pos[0]], d1: m1[pos[1]], eval: evaluate(), legal: state.legal() };
}
