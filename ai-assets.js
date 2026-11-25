// Public bundled binaries only. External API requests never use this cache.
export const AI_CACHE = "quoridor.ai-assets.v1";
export const AI_REVISIONS = {
  "models/claustrophobia_v1_3_1.onnx": "576807f1c9686d42c6793581f181407aec8b510b52dc3efbda7c4ba5ce8e5b34",
  "models/sigma_9x9.onnx": "d790dac68389f7602ff8a887a2385417d3c925fe22da7164c86e9226f943908d",
  "models/sigma_9x9_batch.onnx": "b6faa17e7a788d3e296a774301e6e0e878e31ac7df47b772a5059b01ad60d914",
  "vendor/ort/ort-wasm-simd-threaded.jsep.wasm": "b45970d0632383a057c27ca5b660b216f8e00c17cf8db9f6207b5e4abc839368",
};
const pending = new Map();
let generation = 0;
const activeAssets = new Map(), progressListeners = new Set();

export function subscribeAIAssets(listener) {
  progressListeners.add(listener);
  listener([...activeAssets.values()]);
  return () => progressListeners.delete(listener);
}
function publishProgress(url, progress) {
  if (progress.phase === "ready" || progress.phase === "error") activeAssets.delete(url);
  else activeAssets.set(url, { url, ...progress });
  for (const listener of progressListeners) {
    try { listener([...activeAssets.values()]); } catch {}
  }
}

async function downloadBytes(response, report) {
  const total = Number(response.headers.get("Content-Length")) || null;
  report({ phase: "download", loaded: 0, total });
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    report({ phase: "verify", loaded: bytes.length, total: bytes.length });
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); loaded += value.length;
      report({ phase: "download", loaded, total });
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  report({ phase: "verify", loaded, total: loaded });
  return bytes;
}

async function verifiedBytes(response, revision, report) {
  const bytes = report ? await downloadBytes(response, report) : new Uint8Array(await response.arrayBuffer());
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== revision) throw new Error("The AI download is incomplete or outdated. Reload to try again.");
  return bytes;
}

export async function cachedAIBytes(url, revision, {
  cacheStorage = globalThis.caches, fetchImpl = globalThis.fetch, onProgress = () => {},
} = {}) {
  const key = new URL(url);
  key.searchParams.set("quoridor-ai", revision);
  const requestKey = key.href;
  const existing = pending.get(requestKey);
  if (existing && existing.cacheStorage === cacheStorage) {
    existing.listeners.add(onProgress);
    if (existing.progress) { try { onProgress(existing.progress); } catch {} }
    try { return await existing.promise; }
    finally { existing.listeners.delete(onProgress); }
  }
  const entry = { cacheStorage, listeners: new Set([onProgress]), progress: null, promise: null };
  const report = (progress) => {
    entry.progress = progress;
    for (const listener of entry.listeners) { try { listener(progress); } catch {} }
  };
  const startedGeneration = generation;
  const promise = (async () => {
    report({ phase: "cache", loaded: 0, total: null });
    let cache;
    try { cache = await cacheStorage?.open(AI_CACHE); } catch {}
    if (cache) {
      try {
        const hit = await cache.match(requestKey);
        if (hit) {
          const bytes = await verifiedBytes(hit, revision);
          report({ phase: "ready", source: "cache", loaded: bytes.length, total: bytes.length });
          return bytes;
        }
      } catch { try { await cache.delete(requestKey); } catch {} }
    }
    const response = await fetchImpl(url, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`AI download failed (HTTP ${response.status}). Please try again.`);
    const bytes = await verifiedBytes(response, revision, report);
    if (cache && startedGeneration === generation) {
      try { await cache.put(requestKey, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })); } catch {}
    }
    report({ phase: "ready", source: "network", loaded: bytes.length, total: bytes.length });
    return bytes;
  })().catch((error) => { report({ phase: "error" }); throw error; });
  entry.promise = promise; pending.set(requestKey, entry);
  try { return await promise; }
  finally { if (pending.get(requestKey) === entry) pending.delete(requestKey); }
}

export function loadAIAsset(relative) {
  const url = new URL(relative, import.meta.url);
  const name = Object.keys(AI_REVISIONS).find((name) => new URL(name, import.meta.url).href === url.href);
  if (!name) throw new Error("Unknown bundled AI asset");
  return cachedAIBytes(url.href, AI_REVISIONS[name], { onProgress: (progress) => publishProgress(url.href, progress) });
}

export async function clearAIAssets(cacheStorage = globalThis.caches) {
  generation++;
  try { await cacheStorage?.delete(AI_CACHE); } catch {}
}
