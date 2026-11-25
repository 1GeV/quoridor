// Batched Sigma (GPU path, but CPU here) against the sequential Sigma agent.
// Usage: node tools/match_batch.mjs [games] [simsBatch] [simsSeq] [batchSize]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State } from "../rules.js";
import { SigmaNet, SigmaAgent, SigmaBatchAgent } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;

const games = Number(process.argv[2] || 2);
const simsA = Number(process.argv[3] || 512);
const simsB = Number(process.argv[4] || 64);
const batch = Number(process.argv[5] || 16);

const batchNet = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9_batch.onnx"), ort, {
  executionProviders: ["wasm"],
});
const seqNet = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9.onnx"), ort);

for (let g = 0; g < games; g++) {
  const batchFirst = g % 2 === 0;
  const aBatch = new SigmaBatchAgent(batchNet, { sims: simsA, batch });
  const aSeq = new SigmaAgent(seqNet, { sims: simsB });
  let s = State.new();
  const moves = [];
  const t0 = Date.now();
  while (!s.terminal && moves.length < 240) {
    const whitesBatch = s.turn === (batchFirst ? 0 : 1);
    const agent = whitesBatch ? aBatch : aSeq;
    const a = await agent.choose(s, { temperature: 0 });
    if (a === null) break;
    moves.push(a);
    s = s.doAction(a);
    aBatch.advance(a);
    aSeq.advance(a);
  }
  const batchColor = batchFirst ? 0 : 1;
  const winner = s.terminal
    ? s.winner === batchColor
      ? "batch"
      : "seq"
    : "unfinished";
  console.log(
    `game ${g}: ${winner} in ${moves.length} plies, ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
      `walls batch=${s.walls[0]}/${s.walls[1]}`
  );
  console.log("moves:", moves.join(","));
}
