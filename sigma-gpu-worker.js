let adapter, session;

self.onmessage = async ({ data: { id, type, model, wasm, data, batch } }) => {
  try {
    if (type === "probe") {
      adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
      self.postMessage({ id, result: !!adapter });
    } else if (type === "load") {
      importScripts("./vendor/ort/ort.min.js");
      const { env, InferenceSession } = self.ort;
      env.wasm.proxy = false;
      env.wasm.numThreads = 1;
      env.wasm.wasmPaths = new URL("./vendor/ort/", self.location.href).href;
      env.wasm.wasmBinary = wasm;
      env.webgpu.adapter = adapter;
      session = await InferenceSession.create(model, {
        executionProviders: ["webgpu"], graphOptimizationLevel: "all",
      });
      delete env.wasm.wasmBinary;
      self.postMessage({ id });
    } else {
      const input = new self.ort.Tensor("float32", data, [batch, 8, 9, 9]);
      const out = await session.run({ [session.inputNames[0]]: input });
      const logits = (out.policy ?? out[session.outputNames[0]]).data.slice();
      const values = (out.value ?? out[session.outputNames[1]]).data.slice();
      self.postMessage({ id, result: { logits, values } }, [logits.buffer, values.buffer]);
    }
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
