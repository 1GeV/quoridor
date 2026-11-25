import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { ClaustrophobiaNet, encodeChampion } from "../claustrophobia.js";
import { State } from "../rules.js";

test("Claustrophobia's encoder is invariant under role-swapped rotation", () => {
  const original = State.new().doAction(67).doAction(90).doAction(176);
  const rotated = new State(
    [80 - original.pos[1], 80 - original.pos[0]], [...original.walls].reverse(),
    original.hw.slice().reverse(), original.vw.slice().reverse(), 1 - original.turn,
  );
  assert.deepEqual(encodeChampion(original), encodeChampion(rotated));
});

test("the released model assigns a normalized policy to legal moves", async () => {
  globalThis.ort = ort;
  const url = fileURLToPath(new URL("../models/claustrophobia_v1_3_1.onnx", import.meta.url));
  const net = await ClaustrophobiaNet.load(url);
  try {
    for (const position of [State.new(), State.new().doAction(67).doAction(90).doAction(176)]) {
      const [policy, value] = await net.evaluate(position);
      const legal = new Set(position.legal());
      assert.ok(Number.isFinite(value) && Math.abs(value) <= 1);
      assert.ok(Math.abs(policy.reduce((sum, p) => sum + p, 0) - 1) < 1e-6);
      assert.ok(policy.every((p, action) => !p || legal.has(action)));
    }
  } finally {
    await net.session.release();
  }
});
