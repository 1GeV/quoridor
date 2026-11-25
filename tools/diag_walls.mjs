// Compare Sigma's value after each candidate wall in a fixed position.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State, actionStr } from "../rules.js";
import { SigmaNet } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;
const net = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9.onnx"), ort, { executionProviders: ["wasm"] });

const seq = "67,13,58,22,49,31,40".split(",").map(Number);
let s = State.new();
for (const a of seq) s = s.doAction(a);
const [pri, value] = await net.evaluate(s);
console.log("root value (blue)", value.toFixed(4));
const top = Object.entries(pri).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, p]) => [Number(a), p]);
for (const [a, p] of top) {
  const s2 = s.doAction(a);
  const [p2, v2] = await net.evaluate(s2);
  const d = s.distances();
  console.log(actionStr(a).padEnd(6), "prior", p.toFixed(3), "child value red", v2.toFixed(3), "blue", (-v2).toFixed(3), "dist", d[0][s.pos[0]], d[1][s.pos[1]]);
}
