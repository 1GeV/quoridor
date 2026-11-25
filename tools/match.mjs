// A/B match: Sigma (MCTS + net) vs Alpha-beta, both playing both colours.
// Usage: node tools/match.mjs [games] [sims] [depth] [ms]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State } from "../rules.js";
import { SigmaNet, SigmaAgent } from "../sigma.js";
import { AlphaBetaAgent } from "../alphabeta.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const model = path.join(here, "..", "models", "sigma_9x9.onnx");

const GAMES = Number(process.argv[2] || 4);
const SIMS = Number(process.argv[3] || 128);
const DEPTH = Number(process.argv[4] || 6);
const MS = Number(process.argv[5] || 400);
const WW = Number(process.argv[6] || 8);
const PAR = Number(process.argv[7] || 0);
const NEED = Number(process.argv[8] || 1);
const TEMPO = Number(process.argv[9] || 100);
const HOT = Number(process.argv[10] || 0);

const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;
const net = await SigmaNet.load(model);

function rngFactory(seed) {
  let a = seed | 0;
  return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
}

async function playGame(sigmaSide, seed) {
  const rng = rngFactory(seed);
  const sigma = new SigmaAgent(net, { sims: SIMS, seed });
  const ab = new AlphaBetaAgent({ maxDepth: DEPTH, ms: MS, nodes: 1e9, seed, wallWeight: WW, parity: PAR, need: NEED, tempo: TEMPO, hot: HOT });
  let s = State.new();
  const moves = [];
  const clock = { sigma: 0, ab: 0 };
  while (!s.terminal && s.ply < 200) {
    const t0 = Date.now();
    let a;
    if (s.turn === sigmaSide) a = await sigma.choose(s, { temperature: 0 });
    else a = ab.choose(s);
    const dt = Date.now() - t0;
    if (s.turn === sigmaSide) clock.sigma += dt; else clock.ab += dt;
    if (a === null || a === undefined || !s.legal().includes(a)) {
      console.log(`illegal/null from ${s.turn === sigmaSide ? "sigma" : "ab"} at ply ${s.ply}: ${a}`);
      const legal = s.legal();
      a = legal[Math.floor(rng() * legal.length)];
    }
    moves.push(a);
    s = s.doAction(a);
  }
  const w = s.winner;
  return { sigmaSide, winner: w, ply: s.ply, moves, clock };
}

let scoreAB = 0, scoreSigma = 0;
for (let g = 0; g < GAMES; g++) {
  const sigmaSide = g % 2;               // alternate colours
  const seed = 100 + g * 37;
  const r = await playGame(sigmaSide, seed);
  let verdict = "unfinished";
  if (r.winner === 0 || r.winner === 1) verdict = r.winner === sigmaSide ? "sigma" : "alpha-beta";
  if (verdict === "alpha-beta") scoreAB++; else if (verdict === "sigma") scoreSigma++;
  console.log(
    `game ${g + 1}: sigma=${sigmaSide === 0 ? "RED" : "BLUE"} -> ${verdict} in ${r.ply} plies; ` +
    `sigma ${Math.round(r.clock.sigma / 1000)}s vs ab ${Math.round(r.clock.ab / 1000)}s`
  );
  if (process.env.MOVE_LOG) console.log("  moves: " + r.moves.join(","));
}
console.log(`\nscore  alpha-beta ${scoreAB} : ${scoreSigma} sigma   (${GAMES} games, sims=${SIMS}, depth=${DEPTH}, ms=${MS}, wallWeight=${WW}, parity=${PAR}, need=${NEED}, tempo=${TEMPO}, hot=${HOT})`);
