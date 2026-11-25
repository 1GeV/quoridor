// Ask the Sigma net what it likes in a position reached by the auto game.
// Usage: node tools/diag_sigma.mjs 67,58,58,49,49,40,40
import path from "node:path";
import { fileURLToPath } from "node:url";
import { State, actionStr } from "../rules.js";
import { SigmaNet } from "../sigma.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
globalThis.ort = ort;
const net = await SigmaNet.load(path.join(here, "..", "models", "sigma_9x9.onnx"), ort, { executionProviders: ["wasm"] });

const seq = (process.argv[2] || "67,58,58,49,49,40,40").split(",").filter(Boolean).map(Number);
let s = State.new();
for (const a of seq) s = s.doAction(a);
console.log("ply", s.ply, "turn", s.turn, "pos", s.pos, "walls", s.walls);
const [pri, value] = await net.evaluate(s);
console.log("value", value.toFixed(4));
const top = Object.entries(pri).sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [a, p] of top) console.log(actionStr(Number(a)).padEnd(6), Number(a), p.toFixed(4));
const d = s.distances();
console.log("dist red", d[0][s.pos[0]], "blue", d[1][s.pos[1]]);
