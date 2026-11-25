// Inspect SigmaBatchAgent's root statistics in the position where it walled a2.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State, actionStr } from "../rules.js";
import { SigmaNet, SigmaBatchAgent } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;
const net = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9_batch.onnx"), ort, { executionProviders: ["wasm"] });

let s = State.new();
for (const a of [67, 13, 58, 22, 49, 31, 40]) s = s.doAction(a);
const agent = new SigmaBatchAgent(net, { sims: 1024, batch: 8 });
const best = await agent.choose(s, { temperature: 0 });
console.log("chosen", actionStr(best), best);
const kids = [...agent.root.children.entries()].map(([a, n]) => ({
  a, v: n.visits, q: n.visits ? -(n.value / n.visits) : 0, prior: agent.root.priors[a],
}));
kids.sort((x, y) => y.v - x.v);
for (const k of kids.slice(0, 15)) console.log(actionStr(k.a).padEnd(6), "visits", k.v, "q", k.q.toFixed(3), "prior", (k.prior || 0).toFixed(3));
const d = s.distances();
console.log("dist red", d[0][s.pos[0]], "blue", d[1][s.pos[1]]);
