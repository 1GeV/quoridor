// Uses a separately obtained embedded Barricade engine; no opponent assets are bundled.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { State, actionStr, A_H, A_V } from "../rules.js";
import { DetourAgent } from "../detour.js";
import { searchGuided } from "../guided.js";
import { ClaustrophobiaNet } from "../claustrophobia.js";
import { SigmaAgent } from "../sigma.js";

const [opponentDirectory, ...arguments_] = process.argv.slice(2);
if (!opponentDirectory) throw new Error("Usage: node tools/match_expert.mjs <Barricade Offline directory> [--pairs=4] [--ms=1200] [--mode=guided|puct] [--output=file.jsonl] [--offset=0] [--baseline=path/to/detour.js]");
const options = Object.fromEntries(arguments_.map((arg) => {
  const split = arg.indexOf("=");
  if (!arg.startsWith("--") || split < 3) throw new Error(`Invalid option ${arg}`);
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
const pairs = Number(options.pairs ?? 4), budget = Number(options.ms ?? 1200);
const seedBase = Number(options.seed ?? 20261125);
const offset = Number(options.offset ?? 0), mode = options.mode ?? "guided";
if (!Number.isInteger(pairs) || pairs < 1 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(seedBase) ||
    !Number.isFinite(budget) || budget < 1 || !["guided", "puct"].includes(mode)) throw new Error("Invalid benchmark settings");
const emit = async (record) => {
  const line = JSON.stringify(record);
  console.log(line);
  if (options.output) await fs.appendFile(options.output, line + "\n");
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const root = fileURLToPath(new URL("../", import.meta.url));
const engineDirectory = path.join(path.resolve(opponentDirectory), "engine");
const engineFiles = ["nnue_engine.js", "nnue_engine.wasm", "net.bnnue", "policy.bpol"];
const buffers = await Promise.all(engineFiles.map((file) => fs.readFile(path.join(engineDirectory, file))));
const factory = (await import(pathToFileURL(path.join(engineDirectory, "nnue_engine.js")))).default;
const opponent = await factory({ wasmBinary: buffers[1], locateFile: (file) => path.join(engineDirectory, file) });
opponent.FS.writeFile("/net.bnnue", buffers[2]);
opponent.FS.writeFile("/policy.bpol", buffers[3]);
const init = opponent.cwrap("bz_init", "number", ["string", "string", "number", "number", "number", "number"]);
if (init("/net.bnnue", "/policy.bpol", 16, 0, 0, 0) !== 1) throw new Error("Opponent rejected its networks");
const newGame = opponent.cwrap("bz_new_game", null, []);
const setPosition = opponent.cwrap("bz_set_position", "number", ["string"]);
const go = opponent.cwrap("bz_go", "string", ["number"]);
const variety = opponent.cwrap("bz_set_variety", null, ["number", "number", "number", "number"]);
opponent.cwrap("bz_set_choice", null, ["number", "number", "number"])(300, 5, 150);

const ort = await import("onnxruntime-web");
globalThis.ort = ort;
const net = await ClaustrophobiaNet.load(path.join(root, "models", "claustrophobia_v1_3_1.onnx"));
await net.evaluate(State.new());
const Search = options.baseline ? (await import(pathToFileURL(path.resolve(options.baseline)))).DetourAgent : DetourAgent;

function random(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
function opening(index) {
  const rng = random(0x6b17c3a9 + Math.imul(index + 1, 2654435761));
  let state = State.new();
  const moves = [];
  const count = 4 + 2 * (index % 5);
  for (let ply = 0; ply < count; ply++) {
    const distances = state.distances()[state.turn];
    const pawns = state.moves().filter((action) => distances[action] <= state.dist(state.turn));
    let choices = pawns;
    if (rng() < 0.32) {
      const walls = state.wallsLegal().filter((action) => {
        const child = state.doAction(action);
        return child.dist(state.turn) - state.dist(state.turn) <= 1 &&
          child.dist(1 - state.turn) - state.dist(1 - state.turn) <= 2;
      });
      if (walls.length) choices = walls;
    }
    const action = choices[Math.floor(rng() * choices.length)];
    moves.push(action);
    state = state.doAction(action);
  }
  return moves;
}
function notation(action) {
  const label = actionStr(action);
  return action < A_H ? label : label.slice(2) + label[0].toLowerCase();
}
function decode(text) {
  const match = /^([a-i])([1-9])([hv])?$/i.exec(text);
  if (!match) throw new Error(`Unrecognized opponent action ${text}`);
  const col = match[1].toLowerCase().charCodeAt(0) - 97, row = Number(match[2]) - 1;
  return match[3] ? (match[3].toLowerCase() === "h" ? A_H : A_V) + row * 8 + col : row * 9 + col;
}
const schedule = Array.from({ length: pairs }, (_, i) => ({ index: offset + i, moves: opening(offset + i) }));
await emit({ type: "settings", date: new Date().toISOString(), mode, budget, pairs, offset,
  policyWeight: Number(options.weight ?? 220), expertNodes: 50000,
  expertVariety: { margin: 20, plies: 6, topk: 3, seedBase },
  opponentHashes: Object.fromEntries(engineFiles.map((file, i) => [file, hash(buffers[i])])),
  searchHash: hash(await fs.readFile(options.baseline
    ? path.join(path.dirname(options.baseline), "vendor", "detour", "engine.js")
    : path.join(root, "vendor", "detour", "engine.js"))), schedule });
const totals = { ours: 0, expert: 0, unfinished: 0 };
const clocks = { ours: [], expert: [] };
try {
  for (const start of schedule) for (const side of [0, 1]) {
    let state = State.new();
    const moves = [...start.moves], samples = [];
    for (const action of moves) {
      if (!state.legal().includes(action)) throw new Error(`Illegal opening ${start.index}`);
      state = state.doAction(action);
    }
    newGame();
    variety(20, 6, 3, seedBase + start.index);
    const agent = mode === "puct" ? new SigmaAgent(net, { sims: 100000 }) : new Search({ ms: budget, maxDepth: 24 });
    let reason;
    while (!state.terminal && state.ply < 320) {
      const actor = state.turn === side ? "ours" : "expert";
      const started = performance.now();
      let action;
      if (actor === "ours") {
        if (mode === "puct") action = await agent.choose(state, { ms: budget });
        else action = (await searchGuided(state, {
          ms: budget, loadNet: () => net,
          search: (settings) => ({ action: agent.choose(state, { ...settings, policyWeight: Number(options.weight ?? 220) }) }),
        })).action;
      } else {
        const accepted = setPosition(moves.map(notation).join(" "));
        if (accepted !== moves.length) throw new Error(`Opponent rejected history: ${accepted}/${moves.length}`);
        action = decode(String(go(50000)).split(" ")[0]);
      }
      const ms = performance.now() - started;
      if (!state.legal().includes(action)) throw new Error(`${actor} returned illegal action ${action} at ply ${state.ply}`);
      clocks[actor].push(ms);
      samples.push({ actor, ply: state.ply, action, ms: Math.round(ms), ...(actor === "ours" ? agent.stats : {}) });
      moves.push(action);
      state = state.doAction(action);
      agent.advance?.(action);
    }
    const winner = !state.terminal ? "unfinished" : state.winner === side ? "ours" : "expert";
    totals[winner]++;
    await emit({ type: "game", opening: start.index, side, winner, ply: state.ply,
      reason: reason ?? (!state.terminal ? "benchmark move limit" : "goal reached"), moves, samples, totals: { ...totals } });
  }
  await emit({ type: "summary", totals, timings: Object.fromEntries(Object.entries(clocks).map(([name, times]) => {
    const sorted = times.toSorted((a, b) => a - b);
    return [name, { moves: times.length, meanMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      p95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]) }];
  })) });
} finally {
  await net.session.release();
}
