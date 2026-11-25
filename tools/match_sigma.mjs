// A/B: Sigma with cross-move tree reuse vs Sigma that rebuilds its tree.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State } from "../rules.js";
import { SigmaNet, SigmaAgent } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const model = path.join(here, "..", "models", "sigma_9x9.onnx");
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;
const net = await SigmaNet.load(model, ort);

const SIMS = Number(process.argv[2] || 48);

async function game(reuseA, reuseB, sideA, seed) {
  let s = State.new();
  const A = new SigmaAgent(net, { sims: SIMS, reuse: reuseA, seed });
  const B = new SigmaAgent(net, { sims: SIMS, reuse: reuseB, seed: seed + 1 });
  const t0 = Date.now();
  while (!s.terminal && s.ply < 200) {
    const ag = s.turn === sideA ? A : B;
    const a = await ag.choose(s, { temperature: 0 });
    if (!s.legal().includes(a)) return { ok: false };
    s = s.doAction(a);
    A.advance(a); B.advance(a);
  }
  const winner = !s.terminal ? "unfinished" : s.winner === sideA ? "A" : "B";
  return { ok: true, winner, ply: s.ply, ms: Date.now() - t0 };
}

for (let g = 0; g < 2; g++) {
  const r = await game(true, false, g % 2, 100 + g);
  console.log(`reuse vs no-reuse: ${JSON.stringify(r)}`);
}
