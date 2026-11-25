// Replay the exact browser line with Sigma batch 1024 and tree reuse, printing choices.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State, actionStr } from "../rules.js";
import { SigmaNet, SigmaBatchAgent } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;
const net = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9_batch.onnx"), ort, { executionProviders: ["wasm"] });
const agent = new SigmaBatchAgent(net, { sims: 1024, batch: 8, reuse: true });
let s = State.new();
const human = [67, 58, 49, 40];
for (const h of human) {
  s = s.doAction(h);
  agent.advance(h);
  const t0 = Date.now();
  const a = await agent.choose(s, { temperature: 0 });
  console.log("blue", actionStr(a), a, "ply", s.ply, "ms", Date.now() - t0);
  s = s.doAction(a);
  agent.advance(a);
}
