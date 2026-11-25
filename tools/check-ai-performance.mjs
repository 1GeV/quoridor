// Static-host browser benchmark; local files only, no external AI requests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const debug = process.env.QUORIDOR_CDP_URL || "http://127.0.0.1:9225";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };
const requests = new Map();
const server = http.createServer(async (req, res) => {
  const relative = decodeURIComponent(req.url.split("?")[0]).replace(/^\/quoridor\/?/, "") || "index.html";
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) return res.writeHead(403).end();
  requests.set(relative, (requests.get(relative) || 0) + 1);
  try { res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(await fs.readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(url) {
  const ws = new WebSocket(url); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(), errors = [], warnings = []; let next = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "warning") warnings.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error("Timeout " + method)); }, 60000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (fn, ...args) => {
    const result = await send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (fn) => { for (let i = 0; i < 400; i++) { try { if (await run(fn)) return; } catch (error) { if (!/context/i.test(error.message)) throw error; } await sleep(30); } throw Error("Timeout " + fn + errors.join("\n")); };
  return { ws, send, run, wait, errors, warnings };
}
const browser = await connect((await (await fetch(debug + "/json/version")).json()).webSocketDebuggerUrl);
const results = [], policies = [];
try {
  for (const threaded of [false, true]) {
    const { browserContextId } = await browser.send("Target.createBrowserContext"); let page;
    try {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
      page = await connect((await (await fetch(debug + "/json/list")).json()).find((tab) => tab.id === targetId).webSocketDebuggerUrl);
      await page.send("Page.enable"); await page.send("Runtime.enable");
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('quoridor.prefs.v1', '${JSON.stringify({ mode: "hotseat", engineBlue: "champion:6:1200" })}');${threaded ? "" : "Object.defineProperty(navigator,'serviceWorker',{value:undefined});"}` });
      await page.send("Page.navigate", { url: origin + "/quoridor/" }); await page.wait(() => !!window.quoridor);
      assert.equal(await page.run(() => crossOriginIsolated), threaded);
      for (const engine of ["ab:6:1200", "champion:6:1200", "sigma:0", "sigma:64"]) {
        await page.run(async (engine) => {
          document.querySelector("#continueMode").value = "red";
          document.querySelector("#importFile").accept = ".json,application/json";
          const game = { version: 1, createdAt: new Date().toISOString(), p0: "Benchmark", p1: engine, moves: [67, 13, 58, 22, 49, 31, 121, 101, 123, 180, 125, 32, 127, 96, 144, 33, 175, 198] };
          const file = new File([JSON.stringify(game)], "benchmark.json", { type: "application/json" });
          const transfer = new DataTransfer(); transfer.items.add(file);
          const input = document.querySelector("#importFile"); Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (quoridor.mode !== "replay") throw Error("Could not load benchmark position: " + document.querySelector("#archiveNote").textContent);
          document.querySelector("#continueMode").value = "red";
          document.querySelector("#btnContinue").click();
          document.querySelector("#engineRed").value = "ab:6:1200";
          document.querySelector("#engineRed").dispatchEvent(new Event("change"));
          document.querySelector("#engineBlue").value = "ab:6:1200";
          document.querySelector("#engineBlue").dispatchEvent(new Event("change"));
          document.querySelector("#engineBlue").value = engine;
          document.querySelector("#engineBlue").dispatchEvent(new Event("change"));
        }, engine);
        for (let turn = 0; turn < 4; turn++) {
          const row = await page.run(async () => {
            const started = performance.now(), before = quoridor.state().ply;
            let longest = 0, previous = performance.now();
            const heartbeat = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - previous); previous = now; }, 20);
            try {
              if (quoridor.state().turn === 1) throw Error("Benchmark position must start with Red to move");
              if (!quoridor.move(quoridor.state().legal.find((action) => action < 81))) throw Error("Benchmark move rejected");
              while (quoridor.state().ply < before + 2 && performance.now() - started < 30000) await new Promise((resolve) => setTimeout(resolve, 20));
              return { totalMs: Math.round(performance.now() - started), uiGapMs: Math.round(longest), hint: document.querySelector("#hint").textContent, metrics: quoridor.metrics(), threads: globalThis.ort?.env.wasm.numThreads, proxy: globalThis.ort?.env.wasm.proxy };
            } finally { clearInterval(heartbeat); }
          });
          assert.ok(row.totalMs < 10000, JSON.stringify(row));
          if (engine.startsWith("champion") && turn > 0) assert.equal(row.metrics.guided, true, JSON.stringify({ row, warnings: page.warnings, browserErrors: page.errors }));
          results.push({ threaded, engine, turn, ...row }); console.log(JSON.stringify(results.at(-1)));
        }
      }
      policies.push(await page.run(async () => {
        const { ClaustrophobiaNet } = await import("./claustrophobia.js"), { State } = await import("./rules.js");
        const net = await ClaustrophobiaNet.load("./models/claustrophobia_v1_3_1.onnx");
        try { const [policy, value] = await net.evaluate(State.new().doAction(67).doAction(90).doAction(176)); return { policy: [...policy], value }; }
        finally { await net.session.release(); }
      }));
      if (threaded) {
        const before = requests.get("models/claustrophobia_v1_3_1.onnx") || 0;
        await page.run(() => { window.quoridor = null; }); await page.send("Page.reload"); await page.wait(() => !!window.quoridor);
        await page.run(() => { quoridor.setMode("ai"); document.querySelector("#engineBlue").value = "champion:6:1200"; document.querySelector("#engineBlue").dispatchEvent(new Event("change")); quoridor.move(67); });
        await page.wait(() => quoridor.state().ply >= 2);
        assert.equal(requests.get("models/claustrophobia_v1_3_1.onnx"), before);
        console.log("PASS: a new page session uses verified model bytes without downloading them again");
      }
      assert.deepEqual(page.errors, []);
    } finally { page?.ws.close(); await browser.send("Target.disposeBrowserContext", { browserContextId }); }
  }
  assert.ok(Math.abs(policies[0].value - policies[1].value) < 1e-4);
  assert.ok(policies[0].policy.every((value, index) => Math.abs(value - policies[1].policy[index]) < 1e-4));
  console.log("PASS: single-threaded and multithreaded model outputs agree; full policy evaluation remains active");
} finally { browser.ws.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
