import { winningMove } from "./rules.js";

export async function searchGuided(state, {
  ms, loadNet, search, cancelled = () => false, onModelError = () => {},
  onStage = () => {},
}) {
  if (state.terminal || cancelled()) return null;
  const loadingStarted = performance.now();
  let net;
  if (state.walls[0] + state.walls[1] > 1 && winningMove(state) === undefined) {
    onStage("loading");
    try { net = await loadNet(); }
    catch (error) { if (!cancelled()) onModelError(error); }
  }
  if (cancelled()) return null;
  const loadMs = Math.round(performance.now() - loadingStarted);

  // Loading the model is a first-use cost. Inference counts against every turn.
  const started = performance.now();
  let policy;
  if (net) {
    onStage("inference");
    try { [policy] = await net.evaluate(state); }
    catch (error) { if (!cancelled()) onModelError(error); }
  }
  if (cancelled()) return null;
  const inferenceMs = Math.round(performance.now() - started);
  onStage("search");
  const result = await search({ policy, ms: Math.max(1, ms - (performance.now() - started)) });
  if (cancelled()) return null;
  return { ...result, guided: !!policy, loadMs, inferenceMs, ms: Math.round(performance.now() - started) };
}
