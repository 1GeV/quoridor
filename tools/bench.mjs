import { State } from "../rules.js";
import { AlphaBetaAgent } from "../alphabeta.js";

let s = State.new();
for (const a of [58, 13, 103, 62, 158, 46, 148, 66]) s = s.doAction(a);
for (const cfg of [
  { maxDepth: 4, ms: 5000, nodes: 1e9 },
  { maxDepth: 5, ms: 5000, nodes: 1e9 },
  { maxDepth: 6, ms: 5000, nodes: 1e9 },
  { maxDepth: 7, ms: 5000, nodes: 1e9 },
]) {
  const agent = new AlphaBetaAgent(cfg);
  const t0 = Date.now();
  const a = agent.choose(s);
  const ms = Date.now() - t0;
  const st = agent.stats;
  console.log(
    `depth ${st.depth}  nodes ${st.nodes}  ${ms} ms  ` +
    `${Math.round(st.nodes / (ms / 1000) / 1000)}k nps  score ${st.score}  move ${a}  legal ${s.legal().includes(a)}`
  );
}
