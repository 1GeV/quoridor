import { loadAIAsset } from "./ai-assets.js";

// Each runtime fixes its threading mode when it starts. Keep WebGPU in its own
// worker so an unsuccessful GPU initialization cannot affect the CPU runtime.
export async function openSigmaGpu() {
  const worker = new Worker(new URL("./sigma-gpu-worker.js", import.meta.url));
  const pending = new Map();
  let nextId = 0, failure;
  function close(error = new Error("The local GPU engine was closed")) {
    failure ??= error;
    worker.terminate();
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  }
  worker.onerror = (event) => close(new Error(event.message || "The local GPU engine could not start"));
  worker.onmessageerror = () => close(new Error("Could not read a reply from the local GPU engine"));
  worker.onmessage = ({ data: { id, result, error } }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(result);
  };
  function request(message, transfer = []) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, ...message }, transfer); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  try {
    if (!await request({ type: "probe" })) { close(); return null; }
    const [model, wasm] = await Promise.all([
      loadAIAsset("models/sigma_9x9_batch.onnx"),
      loadAIAsset("vendor/ort/ort-wasm-simd-threaded.jsep.wasm"),
    ]);
    await request({ type: "load", model, wasm });
    return {
      infer: (data, batch) => request({ type: "infer", data, batch }, [data.buffer]),
      release: close,
    };
  } catch (error) {
    close(error);
    throw error;
  }
}
