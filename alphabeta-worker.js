import { State } from "./rules.js";
import { DetourAgent } from "./detour.js";

self.onmessage = ({ data: { position, depth, ms, policy, policyWeight, seen } }) => {
  try {
    const { pos, walls, hw, vw, turn, ply, winner } = position;
    const state = new State(pos, walls, hw, vw, turn, ply, winner);
    const baseDepth = depth * 2 + 4;
    // Guided search can use the full preset time when it reaches the old cap early.
    const maxDepth = policy && depth >= 6 ? Math.max(24, baseDepth) : baseDepth;
    const agent = new DetourAgent({ maxDepth, ms });
    const action = agent.choose(state, { policy, policyWeight, seen: seen ? new Map(seen) : undefined });
    self.postMessage({ action, stats: agent.stats });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
