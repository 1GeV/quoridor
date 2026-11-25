// Fallback player used when the network cannot be loaded: greedy race play
// with a single rule for walls - only spend one if it costs the rival 2 steps.
import { actionStr } from "./rules.js";

export const Heuristic = {
  choose(state) {
    const me = state.turn;
    const other = 1 - me;
    const d = state.distances();
    const own = d[me][state.pos[me]];
    const rival = d[other][state.pos[other]];
    let best = null, bestScore = -Infinity;
    for (const a of state.legal()) {
      const n = state.doAction(a);
      if (n.terminal) return a;
      const nd = n.distances();
      const mySteps = nd[me][n.pos[me]];
      const rivalSteps = nd[other][n.pos[other]];
      let score = rivalSteps - mySteps;
      if (a >= 81) {
        const gain = rivalSteps - rival;
        score -= 0.6;
        if (gain < 2) score -= 1.2;
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best === null ? state.legal()[0] : best;
  },
  describe(a) { return actionStr(a); },
};
