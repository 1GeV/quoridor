// Cross-check: alpha-beta's internal distances must equal rules.js distances.
import { State } from "../rules.js";
import { probe } from "../alphabeta.js";

let bad = 0;
for (let seed = 0; seed < 200; seed++) {
  let a = seed * 7919 + 1;
  const rng = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  let s = State.new();
  for (let i = 0; i < 40 && !s.terminal; i++) {
    const legal = s.legal();
    s = s.doAction(legal[Math.floor(rng() * legal.length)]);
    if (s.terminal) break;
    const p = probe(s);
    const [m0, m1] = s.distances();
    const d0 = m0[s.pos[0]], d1 = m1[s.pos[1]];
    if (p.d0 !== d0 || p.d1 !== d1) {
      bad++;
      if (bad <= 5) console.log(`seed ${seed} ply ${s.ply}: probe ${p.d0}/${p.d1} vs rules ${d0}/${d1}`);
    }
  }
}
console.log(bad === 0 ? "distances agree on all positions" : `${bad} mismatches`);
