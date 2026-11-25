// Batched Sigma (512 sims) against the alpha-beta engine at depth 7 / 2.5 s.
// Usage: node tools/match_ab_batch.mjs [games] [sims] [abDepth] [abMs]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State } from "../rules.js";
import { SigmaNet, SigmaBatchAgent } from "../sigma.js";
import { AlphaBetaAgent } from "../alphabeta.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;

const games = Number(process.argv[2] || 2);
const sims = Number(process.argv[3] || 512);
const abDepth = Number(process.argv[4] || 7);
const abMs = Number(process.argv[5] || 2500);

const net = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9_batch.onnx"), ort, {
  executionProviders: ["wasm"],
});

for (let g = 0; g < games; g++) {
  const sigmaRed = g % 2 === 0;
  const sigma = new SigmaBatchAgent(net, { sims, batch: 8 });
  const ab = new AlphaBetaAgent({ maxDepth: abDepth, ms: abMs, nodes: 1e9 });
  let s = State.new();
  const moves = [];
  const t0 = Date.now();
  while (!s.terminal && moves.length < 200) {
    const sigmaTurn = s.turn === (sigmaRed ? 0 : 1);
    const a = sigmaTurn ? await sigma.choose(s, { temperature: 0 }) : ab.choose(s);
    if (a === null) break;
    moves.push(a);
    s = s.doAction(a);
    sigma.advance(a);
  }
  const sigmaColor = sigmaRed ? 0 : 1;
  const winner = s.terminal
    ? s.winner === sigmaColor
      ? "sigma"
      : "alphabeta"
    : "unfinished";
  console.log(
    `game ${g}: ${winner} in ${moves.length} plies, ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
      `walls red=${s.walls[0]} blue=${s.walls[1]}`
  );
  console.log("moves:", moves.join(","));
}
