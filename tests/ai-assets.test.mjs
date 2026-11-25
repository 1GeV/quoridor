import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { AI_CACHE, AI_REVISIONS, cachedAIBytes, clearAIAssets, pruneAIAssets } from "../ai-assets.js";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const url = "https://example.invalid/quoridor/models/test.onnx";
function storage() {
  const entries = new Map(), deleted = [];
  const cache = { match: async (key) => entries.get(key)?.clone(), put: async (key, response) => { entries.set(key, response.clone()); }, delete: async (key) => entries.delete(key) };
  return { entries, deleted, open: async () => cache, delete: async (name) => { deleted.push(name); entries.clear(); } };
}

test("AI cache revisions exactly match every bundled model and runtime binary", async () => {
  for (const [name, revision] of Object.entries(AI_REVISIONS)) {
    assert.equal(hash(await fs.readFile(new URL("../" + name, import.meta.url))), revision, name);
  }
});

test("verified AI binaries persist across loads and revisions use separate cache entries", async () => {
  const cacheStorage = storage(), bytes = new Uint8Array([1, 2, 3]); let fetches = 0;
  const fetchImpl = async () => { fetches++; return new Response(bytes); };
  assert.deepEqual(await cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl }), bytes);
  assert.deepEqual(await cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl }), bytes);
  assert.equal(fetches, 1);
  const newer = new Uint8Array([4, 5, 6]);
  assert.deepEqual(await cachedAIBytes(url, hash(newer), { cacheStorage, fetchImpl: async () => { fetches++; return new Response(newer); } }), newer);
  assert.equal(fetches, 2); assert.equal(cacheStorage.entries.size, 2);
});

test("opening the game drops obsolete AI downloads for this deployment only", async () => {
  const cacheStorage = storage();
  const base = new URL("https://example.invalid/quoridor/");
  const model = "models/claustrophobia_v1_3_1.onnx";
  const assetURL = (path, revision) => new URL(path + "?quoridor-ai=" + revision, base).href;
  const current = assetURL(model, AI_REVISIONS[model]);
  const otherDeployment = assetURL("../other/models/claustrophobia_v1_3_1.onnx", "old");
  const unrelated = assetURL("models/readme.txt", "old");
  const obsolete = [assetURL(model, "old"), assetURL("models/retired.onnx", "old")];
  const cache = await cacheStorage.open(AI_CACHE);
  cacheStorage.has = async (name) => name === AI_CACHE;
  cache.keys = async () => [...cacheStorage.entries.keys()].map((url) => new Request(url));
  const deleteEntry = cache.delete;
  cache.delete = async (request) => deleteEntry(request.url);
  for (const url of [current, otherDeployment, unrelated, ...obsolete]) await cache.put(url, new Response("bytes"));
  await pruneAIAssets(cacheStorage, base);
  assert.deepEqual([...cacheStorage.entries.keys()], [current, otherDeployment, unrelated]);
});

test("corrupt cache entries are replaced; incomplete network downloads are never cached", async () => {
  const cacheStorage = storage(), bytes = new Uint8Array([7, 8, 9]); let fetches = 0;
  const key = url + "?quoridor-ai=" + hash(bytes);
  cacheStorage.entries.set(key, new Response("corrupted"));
  assert.deepEqual(await cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl: async () => { fetches++; return new Response(bytes); } }), bytes);
  assert.equal(fetches, 1);
  cacheStorage.entries.clear();
  await assert.rejects(cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl: async () => new Response("partial") }), /incomplete or outdated/);
  assert.equal(cacheStorage.entries.size, 0);
  await assert.rejects(cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl: async () => new Response("unavailable", { status: 503 }) }), /HTTP 503/);
  assert.equal(cacheStorage.entries.size, 0);
});

test("AI remains loadable when browser caching is unavailable", async () => {
  const bytes = new Uint8Array([4, 2]);
  assert.deepEqual(await cachedAIBytes(url, hash(bytes), { cacheStorage: { open() { throw Error("Storage disabled"); } }, fetchImpl: async () => new Response(bytes) }), bytes);
});

test("asset progress reports byte downloads, verification and cache reuse", async () => {
  const cacheStorage = storage(), bytes = new Uint8Array([1, 3, 5, 7]), progress = [];
  const result = await cachedAIBytes(url, hash(bytes), {
    cacheStorage, onProgress: (value) => progress.push(value),
    fetchImpl: async () => new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }),
  });
  assert.deepEqual(result, bytes);
  assert.equal(progress[0].phase, "cache");
  assert.ok(progress.some((value) => value.phase === "download" && value.loaded === 0 && value.total === 4));
  assert.ok(progress.some((value) => value.phase === "download" && value.loaded === 4 && value.total === 4));
  assert.ok(progress.some((value) => value.phase === "verify" && value.loaded === 4));
  assert.deepEqual(progress.at(-1), { phase: "ready", source: "network", loaded: 4, total: 4 });
  const cached = [];
  await cachedAIBytes(url, hash(bytes), { cacheStorage, onProgress: (value) => cached.push(value), fetchImpl: async () => assert.fail("cache unexpectedly missed") });
  assert.deepEqual(cached.map((value) => value.phase), ["cache", "ready"]);
  assert.equal(cached.at(-1).source, "cache");
});

test("concurrent AI loads share a download and clearing data prevents an in-flight load from repopulating its cache", async () => {
  const cacheStorage = storage(), bytes = new Uint8Array([2, 4]); let finish, fetches = 0;
  const fetchImpl = () => { fetches++; return new Promise((resolve) => { finish = () => resolve(new Response(bytes)); }); };
  const first = cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl });
  const second = cachedAIBytes(url, hash(bytes), { cacheStorage, fetchImpl });
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetches, 1);
  await clearAIAssets(cacheStorage); finish();
  assert.deepEqual(await first, bytes); assert.deepEqual(await second, bytes);
  assert.deepEqual(cacheStorage.deleted, [AI_CACHE]); assert.equal(cacheStorage.entries.size, 0);
});
