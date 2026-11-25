// Sanity duels between the alpha-beta engine and the built-in heuristic.
import { State } from "../rules.js";
import { AlphaBetaAgent } from "../alphabeta.js";
import { Heuristic } from "../heuristic.js";

function play(agentA, agentB, sideA, seed) {
  let s = State.new();
  let a = seed;
  const rng = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  while (!s.terminal && s.ply < 200) {
    const act = s.turn === sideA ? agentA.choose(s) : agentB.choose(s);
    if (!s.legal().includes(act)) return { ok: false, act };
    s = s.doAction(act);
  }
  return { ok: true, winner: !s.terminal ? "unfinished" : (s.winner === sideA ? "A" : "B"), ply: s.ply };
}

const cfg = { maxDepth: Number(process.argv[2] || 7), ms: Number(process.argv[3] || 1000) };
for (let g = 0; g < 2; g++) {
  const ab = new AlphaBetaAgent(cfg);
  const r = play(ab, Heuristic, g % 2, 50 + g);
  console.log("AB vs Heuristic:", JSON.stringify(r));
}
for (let g = 0; g < 2; g++) {
  const deep = new AlphaBetaAgent({ maxDepth: 6, ms: 700 });
  const shallow = new AlphaBetaAgent({ maxDepth: 2, ms: 30 });
  const r = play(deep, shallow, g % 2, 70 + g);
  console.log("AB d6 vs d2:", JSON.stringify(r));
}
