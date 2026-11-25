import { State } from "../rules.js";
import { searchGuided } from "../guided.js";
import { DetourAgent } from "../detour.js";
import { SigmaAgent, SigmaNet } from "../sigma.js";
import { fileURLToPath } from "node:url";

const openings = [
  [],
  [67, 13, 58, 22, 49, 31],
  [75, 5, 66, 14, 57, 23],
  [77, 13, 68, 22, 117, 21],
  [67, 3, 115, 12, 58, 21],
  [75, 13, 106, 22],
  [77, 3, 125, 12, 68, 21],
  [67, 13, 116, 125],
];

function summarize(samples) {
  const times = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  const round = (n) => Math.round(n * 10) / 10;
  const mean = (values) => values.length ? round(values.reduce((sum, x) => sum + x, 0) / values.length) : null;
  return {
    turns: times.length,
    meanMs: mean(times),
    p95Ms: round(times[Math.ceil(times.length * .95) - 1]),
    maxMs: round(times.at(-1)),
    meanSimsWhenSearching: mean(samples.map(({ sims }) => sims).filter((sims) => sims > 0)),
    meanCacheHitsWhenSearching: mean(samples.filter(({ sims }) => sims > 0).map(({ cacheHits }) => cacheHits)),
  };
}

async function playMatch({ budget, pairs, openingOffset, first, second }) {
  if (!Number.isFinite(budget) || budget < 1 || !Number.isInteger(pairs) || pairs < 1 ||
      !Number.isInteger(openingOffset) || openingOffset < 0 || openingOffset + pairs > openings.length) {
    throw new Error(`Usage: node tools/match_sigma_detour.mjs [milliseconds>=1] [pairs>=1] [opening offset>=0] [sigma|guided], ${openings.length} openings available`);
  }
  const scores = { [first[0]]: 0, [second[0]]: 0, unfinished: 0 };
  const samples = Object.fromEntries([first, second].map(([name]) => [name, []]));
  console.log({ budget, pairs, openingOffset, matchup: [first[0], second[0]] });
  for (let i = openingOffset; i < openingOffset + pairs; i++) {
    const initial = openings[i].reduce((state, action) => {
      if (!state.legal().includes(action)) throw new Error(`Invalid opening ${i + 1}, action ${action}`);
      return state.doAction(action);
    }, State.new());
    for (const firstSide of [0, 1]) {
      const players = [first, second].map(([name, create]) => [name, create()]);
      if (firstSide === 1) players.reverse();
      let state = initial;
      while (!state.terminal && state.ply < 240) {
        const [name, agent] = players[state.turn];
        const start = performance.now();
        const action = await agent.choose(state, { ms: budget });
        samples[name].push({ ms: performance.now() - start, sims: agent.lastSims, cacheHits: agent.lastCacheHits });
        if (!state.legal().includes(action)) throw new Error(`${name} returned illegal action ${action} at ply ${state.ply}`);
        state = state.doAction(action);
        for (const [, player] of players) player.advance?.(action);
      }
      const result = !state.terminal ? "unfinished" : players[state.winner][0];
      scores[result]++;
      console.log(`Opening ${i + 1} · ${first[0]} ${firstSide === 0 ? "Red" : "Blue"} · ${result} · ${state.ply} plies`);
    }
  }
  console.log(JSON.stringify({ scores, summary: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)])) }, null, 2));
}

const budget = Number(process.argv[2] ?? 2000);
const pairs = Number(process.argv[3] ?? 2);
const openingOffset = Number(process.argv[4] ?? 0);
const mode = process.argv[5] ?? "sigma";
if (mode !== "sigma" && mode !== "guided") throw new Error("Engine must be sigma or guided");
const ort = await import("onnxruntime-web");
globalThis.ort = ort;
const model = fileURLToPath(new URL("../models/sigma_9x9.onnx", import.meta.url));
const net = await SigmaNet.load(model, ort);
await net.raw(State.new());
function guidedPlayer() {
  const engine = new DetourAgent({ ms: budget });
  return {
    async choose(state) {
      const result = await searchGuided(state, {
        ms: budget, loadNet: () => net,
        search: (options) => ({ action: engine.choose(state, options) }),
      });
      return result.action;
    },
  };
}
await playMatch({
  budget, pairs, openingOffset,
  first: mode === "guided" ? ["Guided", guidedPlayer] : ["Sigma", () => new SigmaAgent(net, { sims: 2048 })],
  second: ["Detour", () => new DetourAgent({ ms: budget })],
});
await net.session.release();
