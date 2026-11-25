import { State } from "../rules.js";
import { AlphaBetaAgent } from "../alphabeta.js";
import { DetourAgent } from "../detour.js";

const budget = Number(process.argv[2] ?? 180);
const count = Number(process.argv[3] ?? 6);
const openings = [
  [67, 13, 58, 22, 49, 31],
  [75, 5, 66, 14, 57, 23],
  [77, 13, 68, 22, 117, 21],
  [67, 3, 115, 12, 58, 21],
  [75, 13, 106, 22],
  [77, 3, 125, 12, 68, 21],
];
if (!Number.isFinite(budget) || budget < 1 || !Number.isInteger(count) || count < 1 || count > openings.length) {
  throw new Error("Usage: node tools/match_detour.mjs [milliseconds>=1] [opening pairs 1-6]");
}
const starts = openings.slice(0, count).map((opening) => opening.reduce((state, action) => {
  if (!state.legal().includes(action)) throw new Error(`Invalid opening action ${action} in ${opening}`);
  return state.doAction(action);
}, State.new()));
const totals = { Detour: 0, original: 0, unfinished: 0 };
const measured = Array.from({ length: 2 }, () => ({ searches: 0, ms: 0, depth: 0 }));

for (let i = 0; i < starts.length; i++) for (const side of [0, 1]) {
  const detour = new DetourAgent({ maxDepth: 16, ms: budget });
  const original = new AlphaBetaAgent({ maxDepth: 12, ms: budget, nodes: Infinity });
  let state = starts[i];
  while (!state.terminal && state.ply < 240) {
    const enhanced = state.turn === side;
    const engine = enhanced ? detour : original;
    const start = performance.now();
    const action = engine.choose(state);
    const stats = measured[Number(enhanced)];
    stats.ms += performance.now() - start;
    stats.depth += engine.stats.depth;
    stats.searches++;
    if (!state.legal().includes(action)) throw new Error(`Illegal action ${action} at ply ${state.ply}`);
    state = state.doAction(action);
  }
  const result = !state.terminal ? "unfinished" : state.winner === side ? "Detour" : "original";
  totals[result]++;
  console.log(`Opening ${i + 1} · Detour ${side ? "Blue" : "Red"} · ${result} · ${state.ply} moves`);
}
const mean = (stats) => ({ ms: +(stats.ms / stats.searches).toFixed(1), depth: +(stats.depth / stats.searches).toFixed(1) });
console.log({ budget, totals, original: mean(measured[0]), Detour: mean(measured[1]) });
