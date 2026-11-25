import { winningMove } from "./rules.js";

export async function searchGuided(state, {
  ms, loadNet, search, cancelled = () => false, onModelError = () => {},
}) {
  if (state.terminal || cancelled()) return null;
  let net;
  if (state.walls[0] + state.walls[1] > 1 && winningMove(state) === undefined) {
    try { net = await loadNet(); }
    catch (error) { if (!cancelled()) onModelError(error); }
  }
  if (cancelled()) return null;

  // Loading the model is a first-use cost. Inference counts against every turn.
  const started = performance.now();
  let policy;
  if (net) {
    try { [policy] = await net.evaluate(state); }
    catch (error) { if (!cancelled()) onModelError(error); }
  }
  if (cancelled()) return null;
  const result = await search({ policy, ms: Math.max(1, ms - (performance.now() - started)) });
  if (cancelled()) return null;
  return { ...result, guided: !!policy, ms: Math.round(performance.now() - started) };
}
