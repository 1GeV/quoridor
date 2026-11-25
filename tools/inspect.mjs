// Decode a logged game and flag moves that made the mover's own path longer.
import { State, actionStr } from "../rules.js";

const seq = (process.env.MOVES || "").split(",").filter(Boolean).map(Number);
let s = State.new();
for (let i = 0; i < seq.length; i++) {
  const a = seq[i];
  const d = s.distances();
  const me = s.turn;
  const before = me === 0 ? d[0][s.pos[0]] : d[1][s.pos[1]];
  const s2 = s.doAction(a);
  const d2 = s2.distances();
  const after = me === 0 ? d2[0][s2.pos[0]] : d2[1][s2.pos[1]];
  const other = s2.pos[1 - me];
  const otherBefore = me === 0 ? d[1][other] : d[0][other];
  const otherAfter = me === 0 ? d2[1][other] : d2[0][other];
  const flag = after > before ? "  <-- own path +" + (after - before) : "";
  console.log(
    String(i + 1).padStart(2) + " " + (me === 0 ? "R" : "B") + " " + actionStr(a).padEnd(5) +
    " my " + before + "->" + after + "  opp " + otherBefore + "->" + otherAfter + flag
  );
  s = s2;
  if (s.terminal) { console.log("winner", s.winner, "ply", s.ply); break; }
}
