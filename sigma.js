import { oneTurnDefences, winningMove } from "./rules.js";
import { raceMove, raceValue } from "./endgame.js";
import { loadAIAsset } from "./ai-assets.js";
export { raceValue } from "./endgame.js";

// Sigma network wrapper for the browser (onnxruntime-web, wasm backend).
// The encoder mirrors quoridor/sigma.py exactly: the net always sees the board
// from the mover's side, mover advancing toward canonical row 8.
import { State, N, A_H, A_V, N_MOVES } from "./rules.js";

export const CANON_DIRS = [[0, 1], [0, -1], [-1, 0], [1, 0], [-1, 1], [1, 1], [-1, -1], [1, -1]];
const MAX_DIST = N * N - 1;

function bfsCanon(hw9, vw9, goalRow) {
  const dist = new Int16Array(81).fill(-1);
  const q = [];
  for (let x = 0; x < N; x++) { dist[goalRow * 9 + x] = 0; q.push([goalRow, x]); }
  let head = 0;
  while (head < q.length) {
    const [y, x] = q[head++];
    const d = dist[y * 9 + x] + 1;
    if (y + 1 < N && dist[(y + 1) * 9 + x] < 0 && !hw9[y * 9 + x]) { dist[(y + 1) * 9 + x] = d; q.push([y + 1, x]); }
    if (y > 0 && dist[(y - 1) * 9 + x] < 0 && !hw9[(y - 1) * 9 + x]) { dist[(y - 1) * 9 + x] = d; q.push([y - 1, x]); }
    if (x + 1 < N && dist[y * 9 + x + 1] < 0 && !vw9[y * 9 + x]) { dist[y * 9 + x + 1] = d; q.push([y, x + 1]); }
    if (x > 0 && dist[y * 9 + x - 1] < 0 && !vw9[y * 9 + x - 1]) { dist[y * 9 + x - 1] = d; q.push([y, x - 1]); }
  }
  return dist;
}

export function encode(state) {
  const p = state.turn;
  const flip = p === 0;
  const cr = (r) => (flip ? 8 - r : r);
  const meR = Math.floor(state.pos[p] / 9), meC = state.pos[p] % 9;
  const opR = Math.floor(state.pos[1 - p] / 9), opC = state.pos[1 - p] % 9;

  const x = new Float32Array(8 * 81);
  x[cr(meR) * 9 + meC] = 1;
  x[81 + cr(opR) * 9 + opC] = 1;

  const hw9 = new Uint8Array(81), vw9 = new Uint8Array(81);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (state.hw[r * 8 + c]) {
        const y = flip ? 7 - r : r;
        hw9[y * 9 + c] = 1; hw9[y * 9 + c + 1] = 1;
      }
      if (state.vw[r * 8 + c]) {
        const y = flip ? 7 - r : r;
        vw9[y * 9 + c] = 1; vw9[(y + 1) * 9 + c] = 1;
      }
    }
  }
  for (let i = 0; i < 81; i++) { x[162 + i] = hw9[i]; x[243 + i] = vw9[i]; }

  const wMe = state.walls[p] / 10, wOp = state.walls[1 - p] / 10;
  for (let i = 0; i < 81; i++) { x[324 + i] = wMe; x[405 + i] = wOp; }

  const dMe = bfsCanon(hw9, vw9, 8), dOp = bfsCanon(hw9, vw9, 0);
  for (let i = 0; i < 81; i++) {
    x[486 + i] = dMe[i] >= 0 ? dMe[i] / MAX_DIST : 1;
    x[567 + i] = dOp[i] >= 0 ? dOp[i] / MAX_DIST : 1;
  }
  return x;
}

function legalActionIndex(state, a) {
  const p = state.turn;
  if (a < N_MOVES) {
    // The rules engine has already checked the path, including sidesteps
    // around a pawn. The network needs only the direction of the destination.
    const from = state.pos[p];
    const dx = a % N - from % N;
    const dy = (Math.floor(a / N) - Math.floor(from / N)) * (p === 0 ? -1 : 1);
    if (dx === 0) return dy > 0 ? 0 : 1;
    if (dy === 0) return dx < 0 ? 2 : 3;
    return (dy > 0 ? 4 : 6) + Number(dx > 0);
  }
  if (a < A_V) {
    const t = a - A_H, r = Math.floor(t / 8), c = t % 8;
    const y = p === 0 ? 7 - r : r;
    return 8 + y * 8 + c;
  }
  const t = a - A_V, r = Math.floor(t / 8), c = t % 8;
  const y = p === 0 ? 7 - r : r;
  return 8 + 64 + y * 8 + c;
}

export function actionIndex(state, a) {
  if (a < N_MOVES && !state.moves().includes(a)) return null;
  return legalActionIndex(state, a);
}

export function legalIndexMap(state) {
  return state.legal().map((action) => [legalActionIndex(state, action), action]);
}

let browserWasmPending = null;
let browserWasmReady = false;
function prepareBrowserWasm(ort) {
  if (browserWasmReady) return Promise.resolve();
  browserWasmPending ??= loadAIAsset("vendor/ort/ort-wasm-simd-threaded.jsep.wasm")
    .then((bytes) => { ort.env.wasm.wasmBinary = bytes; })
    .catch((error) => { browserWasmPending = null; throw error; });
  return browserWasmPending;
}

export async function loadModelSession(url, ortLib, opts = {}) {
  const ort = ortLib || globalThis.ort;
  if (!ort) throw new Error("onnxruntime-web is not loaded");
  if (typeof document !== "undefined") {
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", document.baseURI).href;
    // The local server or scoped service worker supplies isolation for CPU threads.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 2)
      : 1;
    // Keep CPU inference off the UI thread so thinking limits and controls can run.
    ort.env.wasm.proxy = !(opts.executionProviders || []).includes("webgpu");
  } else {
    ort.env.wasm.numThreads = 1;
  }
  ort.env.wasm.simd = true;
  const options = {
    executionProviders: opts.executionProviders || ["wasm"],
    graphOptimizationLevel: "all",
  };
  if (typeof document === "undefined" || !globalThis.crypto?.subtle) return ort.InferenceSession.create(url, options);
  // Fetch the model and runtime together; subsequent visits read verified local bytes.
  const [bytes] = await Promise.all([loadAIAsset(url), prepareBrowserWasm(ort)]);
  const session = await ort.InferenceSession.create(bytes, options);
  browserWasmReady = true;
  delete ort.env.wasm.wasmBinary;
  browserWasmPending = null;
  return session;
}

export class SigmaNet {
  constructor(session, infer) {
    this.session = session;
    this.infer = infer;
  }

  static async load(url, ortLib, opts = {}) {
    const ort = ortLib || globalThis.ort;
    const session = await loadModelSession(url, ort, opts);
    const inputName = session.inputNames[0];
    return new SigmaNet(session, async (data, batch) => {
      const input = new ort.Tensor("float32", data, [batch, 8, 9, 9]);
      const out = await session.run({ [inputName]: input });
      return {
        logits: (out.policy ?? out[session.outputNames[0]]).data,
        values: (out.value ?? out[session.outputNames[1]]).data,
      };
    });
  }

  static cdnPath() {
    return "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
  }

  async raw(state) {
    const { logits, values } = await this.infer(encode(state), 1);
    return [Array.from(logits), Number(values[0])];
  }

  async evaluate(state) {
    const [logits, value] = await this.raw(state);
    return policyAndValue(state, logits, value);
  }

  // Several positions in one forward pass. On the WebGPU backend this is
  // roughly 3 ms per position instead of 30+, which is what makes 256+ sims
  // playable in a browser.
  async rawBatch(states) {
    const n = states.length;
    const data = new Float32Array(n * 8 * 81);
    for (let i = 0; i < n; i++) data.set(encode(states[i]), i * 648);
    const { logits: pol, values: val } = await this.infer(data, n);
    return states.map((s, i) => ({
      logits: pol.subarray(i * 136, (i + 1) * 136),
      value: Number(val[i]),
    }));
  }

  async evaluateBatch(states) {
    const raws = await this.rawBatch(states);
    return raws.map(({ logits, value }, i) => policyAndValue(states[i], logits, value));
  }
}

function policyAndValue(state, logits, value) {
  const pairs = legalIndexMap(state);
  let max = -Infinity;
  for (const [index] of pairs) max = Math.max(max, logits[index]);
  let sum = 0;
  const priors = {};
  for (const [index, action] of pairs) {
    const weight = Math.exp(logits[index] - max);
    priors[action] = weight;
    sum += weight;
  }
  for (const action in priors) priors[action] /= sum;
  return [priors, value];
}

const CACHE_LIMIT = 4096;

// Inference depends on the board, wall counts and mover.
function evaluationKey(state) {
  let walls = "";
  for (let i = 0; i < 64; i += 4) {
    let code = 0;
    for (let j = 0; j < 4; j++) code |= (state.hw[i + j] + 2 * state.vw[i + j]) << (2 * j);
    walls += String.fromCharCode(code);
  }
  return String.fromCharCode(state.turn, state.pos[0], state.pos[1], ...state.walls) + walls;
}

function makeNode(state) {
  return { state, priors: null, actions: null, children: new Map(), visits: 0, value: 0, eval: 0, pending: 0 };
}

export class SigmaAgent {
  constructor(net, { sims = 48, c_puct = 1.5, seed = 7, reuse = true } = {}) {
    this.net = net;
    this.sims = sims;
    this.cPuct = c_puct;
    this.reuse = reuse;
    this.rng = mulberry32(seed);
    this.root = null;
    this.evaluations = new Map();
  }

  reset() {
    this.root = null;
    this.evaluations = new Map();
  }

  advance(action) {
    this.root = this.root?.children.get(action) ?? null;
  }

  async choose(state, { temperature = 0, ms = Infinity, cancelled = () => false, yieldToUI = false } = {}) {
    this.lastSims = 0;
    this.lastCacheHits = 0;
    this.lastTactic = "";
    if (state.terminal || cancelled()) return null;
    const deadline = performance.now() + ms;
    const win = winningMove(state);
    if (win !== undefined) { this.lastTactic = "winning move"; return win; }
    if (state.walls[0] + state.walls[1] <= 1) { this.lastTactic = "solved endgame"; return raceMove(state); }
    let nextYield = performance.now() + 16;
    if (!this.reuse || !this.root || !sameState(this.root.state, state)) this.root = makeNode(state);
    const root = this.root;
    const defences = oneTurnDefences(state);
    const evaluations = this.evaluations;
    if (!root.actions) await this.evaluateNode(root, evaluations);
    if (cancelled()) return null;
    const legal = root.actions.filter((action) => !defences || defences.has(action));
    if (!legal.length) return defences?.values().next().value ?? state.moves()[0];
    if (this.sims <= 0) return this.pick(legal, (action) => root.priors[action], temperature);

    while (this.lastSims < this.sims && !cancelled() && performance.now() < deadline) {
      this.lastSims += await this.simulate(root, defences, evaluations, deadline);
      if (yieldToUI && performance.now() >= nextYield) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        nextYield = performance.now() + 16;
      }
    }
    if (cancelled()) return null;
    const visited = legal.filter((action) => root.children.get(action)?.visits > 0);
    if (!visited.length) return this.pick(legal, (action) => root.priors[action], temperature);
    return this.pick(visited, (action) => root.children.get(action).visits, temperature);
  }

  pick(actions, weightFor, temperature) {
    if (temperature <= 0) return actions.reduce((a, b) => weightFor(a) >= weightFor(b) ? a : b);
    const weights = actions.map((action) => Math.pow(Math.max(weightFor(action), 1e-9), 1 / Math.max(temperature, 1e-6)));
    let target = this.rng() * weights.reduce((sum, weight) => sum + weight, 0);
    for (let i = 0; i < actions.length; i++) {
      target -= weights[i];
      if (target <= 0) return actions[i];
    }
    return actions.at(-1);
  }

  async evaluateNode(node, evaluations) {
    const key = evaluationKey(node.state);
    const cached = evaluations.get(key);
    if (cached) {
      this.lastCacheHits++;
      return expand(node, cached);
    }
    const evaluation = await this.net.evaluate(node.state);
    remember(evaluations, key, evaluation);
    return expand(node, evaluation);
  }

  async simulate(root, defences, evaluations) {
    const path = this.selectPath(root, defences);
    const leaf = path.at(-1);
    const value = resolvedValue(leaf.state) ?? await this.evaluateNode(leaf, evaluations);
    backUp(path, value);
    return 1;
  }

  selectPath(root, defences, pending) {
    const path = [root];
    let node = root;
    while (node.actions?.length) {
      const child = this.select(node, node === root ? defences : null, pending);
      if (!child) {
        // A batch may already contain all the available leaves in this branch.
        pending.add(node);
        if (node === root) return null;
        path.pop();
        node = path.at(-1);
        continue;
      }
      path.push(child);
      node = child;
    }
    return path;
  }

  select(node, defences, pending) {
    const exploration = this.cPuct * Math.sqrt(Math.max(node.visits + node.pending, 1));
    let visitedPrior = 0;
    for (const [action, child] of node.children) {
      if (child.visits && (!defences || defences.has(action))) visitedPrior += node.priors[action];
    }
    // Match the convention used during training: the first visit starts from
    // the parent's estimate, with a penalty as more policy mass is explored.
    const firstPlay = (node.visits ? node.value / node.visits : node.eval) - 0.1 * Math.sqrt(visitedPrior);
    let bestScore = -Infinity, bestAction = null;
    for (const action of node.actions) {
      if (defences && !defences.has(action)) continue;
      const child = node.children.get(action);
      if (pending?.has(child)) continue;
      const visits = child?.visits ?? 0;
      const reserved = child?.pending ?? 0;
      const q = visits ? -child.value / visits : firstPlay;
      const value = reserved ? (q * Math.max(visits, 1) - reserved) / (Math.max(visits, 1) + reserved) : q;
      const score = value + exploration * node.priors[action] / (1 + visits + reserved);
      if (score > bestScore) { bestScore = score; bestAction = action; }
    }
    if (bestAction === null) return null;
    let child = node.children.get(bestAction);
    if (!child) {
      child = makeNode(node.state.doAction(bestAction));
      node.children.set(bestAction, child);
    }
    return child;
  }
}

export class SigmaBatchAgent extends SigmaAgent {
  constructor(net, { sims = 256, batch = 16, ...options } = {}) {
    super(net, { sims, ...options });
    this.batch = Math.max(1, batch);
  }

  async simulate(root, defences, evaluations, deadline) {
    const remaining = deadline - performance.now();
    const perLeafMs = this.batchMsPerLeaf ?? 8;
    const batchLimit = Math.max(1, Math.floor(remaining / perLeafMs));
    const want = Math.min(this.batch, batchLimit, this.sims - this.lastSims);
    const tasks = [];
    const pending = new Set();
    const leaves = new Map();
    for (let i = 0; i < want; i++) {
      const path = this.selectPath(root, defences, pending);
      if (!path) break;
      const leaf = path.at(-1);
      pending.add(leaf);
      for (const node of path) node.pending++;
      const task = { path, leaf, value: resolvedValue(leaf.state) };
      if (task.value === null) {
        const key = evaluationKey(leaf.state);
        const cached = evaluations.get(key);
        if (cached) {
          this.lastCacheHits++;
          task.value = expand(leaf, cached);
        } else {
          if (!leaves.has(key)) leaves.set(key, []);
          else this.lastCacheHits++;
          leaves.get(key).push(task);
        }
      }
      tasks.push(task);
    }

    try {
      if (leaves.size) {
        const groups = [...leaves.entries()];
        const started = performance.now();
        const output = await this.net.evaluateBatch(groups.map(([, group]) => group[0].leaf.state));
        const observed = (performance.now() - started) / groups.length;
        this.batchMsPerLeaf = this.batchMsPerLeaf == null ? observed : .75 * this.batchMsPerLeaf + .25 * observed;
        for (let i = 0; i < groups.length; i++) {
          const [key, group] = groups[i];
          remember(evaluations, key, output[i]);
          for (const task of group) task.value = expand(task.leaf, output[i]);
        }
      }
    } finally {
      for (const { path } of tasks) for (const node of path) node.pending--;
    }
    for (const { path, value } of tasks) backUp(path, value);
    return tasks.length;
  }
}

function remember(cache, key, evaluation) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, evaluation);
}

function backUp(path, value) {
  for (let i = path.length - 1; i >= 0; i--) {
    path[i].visits++;
    path[i].value += value;
    value = -value;
  }
}

function expand(node, [priors, value]) {
  node.priors = priors;
  node.actions = Object.keys(priors).map(Number);
  node.eval = value;
  return value;
}

function resolvedValue(state) {
  if (state.terminal) return raceValue(state);
  if (winningMove(state) !== undefined) return 1;
  return raceValue(state, { cachedOnly: true });
}

function sameState(a, b) {
  if (!a || !b || a.ply !== b.ply || a.turn !== b.turn) return false;
  if (a.pos[0] !== b.pos[0] || a.pos[1] !== b.pos[1]) return false;
  if (a.walls[0] !== b.walls[0] || a.walls[1] !== b.walls[1]) return false;
  for (let i = 0; i < 64; i++) if (a.hw[i] !== b.hw[i] || a.vw[i] !== b.vw[i]) return false;
  return true;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
