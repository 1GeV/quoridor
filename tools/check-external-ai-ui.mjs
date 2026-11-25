// Run after npm run build, with Chromium's remote debugging port available.
// Uses an isolated browser context and local mocks; never calls a paid provider.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const debug = process.env.QUORIDOR_CDP_URL || "http://127.0.0.1:9225";
const calls = [], errors = [], delayed = [];
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".webp": "image/webp" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function touchDrag(page, start, end) {
  const touch = (x, y) => ({ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 });
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch(start.x, start.y)] });
  await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touch(end.x, end.y)] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(80);
}
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const site = http.createServer(async (req, res) => {
  const relative = decodeURIComponent(req.url.split("?")[0]).replace(/^\/quoridor\/?/, "") || "index.html";
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) return res.writeHead(403).end();
  try { res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(await fs.readFile(file)); }
  catch { res.writeHead(404).end(); }
});
const origin = await listen(site);
const api = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/blocked/")) return res.writeHead(403).end();
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  let raw = ""; for await (const part of req) raw += part;
  const body = JSON.parse(raw), messages = body.messages || body.input || [];
  const last = messages.at(-1)?.content;
  const kind = raw.includes("exactly: OK") ? "test" : typeof last === "string" && last.includes("Question:") ? "chat" : "move";
  const board = kind === "move" ? JSON.parse(typeof last === "string" ? last : last[0].text) : null;
  const call = { kind, model: body.model, body, url: req.url, origin: req.headers.origin };
  calls.push(call);
  if (String(body.model).startsWith("failed")) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "mock unavailable" }));
    return;
  }
  const reply = () => {
    if (res.destroyed) return;
    res.setHeader("Content-Type", "application/json");
    const text = kind === "test" ? "OK" : kind === "chat" ? `Reply from ${body.model}.` : JSON.stringify({ move: board.legalActions[0], say: "Mock move." });
    res.end(JSON.stringify(req.url.endsWith("/responses") ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens_details: { cached_tokens: 7 } } }
      : req.url.endsWith("/messages") ? { content: [{ type: "text", text }], usage: { cache_read_input_tokens: 7 } }
      : { choices: [{ message: { content: text } }], usage: { prompt_tokens_details: { cached_tokens: 7 } } }));
  };
  if (body.model.startsWith("delayed")) delayed.push(reply); else reply();
});
const apiOrigin = await listen(api);
const releaseReplies = () => { while (delayed.length) delayed.shift()(); };
const profile = (allowMoveRequests = false, model = "mock-model") => ({ baseUrl: apiOrigin + "/v1", protocol: "chat", model, allowMoveRequests });

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(); let next = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(Error(JSON.stringify(message.error))) : p.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Timeout: " + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (fn, ...args) => {
    const result = await send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (fn) => {
    for (let i = 0; i < 160; i++) {
      try { if (await run(fn)) return; } catch (error) { if (!/context.*destroyed|Cannot find context/i.test(error.message)) throw error; }
      await sleep(30);
    }
    const snapshot = await run(() => ({ url: location.href, ready: document.readyState, isolated: crossOriginIsolated, controlled: !!navigator.serviceWorker.controller, retry: sessionStorage.getItem("quoridor.isolation.reload.v1"), status: document.querySelector("#status")?.textContent, scripts: [...document.scripts].map((script) => script.src), resources: performance.getEntriesByType("resource").map((entry) => entry.name) }));
    throw Error("Condition timed out: " + fn + "\n" + JSON.stringify(snapshot) + "\n" + errors.join("\n"));
  };
  return { ws, send, run, wait };
}

let browser, page, browserContextId;
try {
  const { webSocketDebuggerUrl } = await (await fetch(debug + "/json/version")).json();
  browser = await connect(webSocketDebuggerUrl);
  ({ browserContextId } = await browser.send("Target.createBrowserContext"));
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
  const tab = (await (await fetch(debug + "/json/list")).json()).find((item) => item.id === targetId);
  page = await connect(tab.webSocketDebuggerUrl);
  await page.send("Runtime.enable"); await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__workerStarts=0;const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);window.__workerStarts++;}};" });
  await page.send("Page.navigate", { url: origin + "/quoridor/" });
  await page.wait(() => !!window.quoridor);
  assert.deepEqual(await page.run(() => ({ isolated: crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer !== "undefined" })), { isolated: true, sharedMemory: true });
  console.log("PASS: static hosting starts with cross-origin isolation and shared memory, without server header configuration");
  const modes = await page.run(() => {
    const buttons = [...document.querySelectorAll("#seg button")], rects = buttons.map((button) => button.getBoundingClientRect());
    return { order: buttons.map((button) => button.dataset.mode), columns: getComputedStyle(document.querySelector("#seg")).gridTemplateColumns.split(" ").length, rows: rects.map((rect) => Math.round(rect.top)) };
  });
  assert.deepEqual(modes.order, ["ai", "hotseat", "room", "ai_ai", "replay"]);
  assert.equal(modes.columns, 6);
  assert.equal(modes.rows[0], modes.rows[1]); assert.equal(modes.rows[1], modes.rows[2]);
  assert.equal(modes.rows[3], modes.rows[4]); assert.notEqual(modes.rows[2], modes.rows[3]);
  console.log("PASS: primary modes lead, Room is prominent, and all five mode buttons fill two tidy rows");
  const fresh = async (settings = {}, profiles = [{}, profile()]) => {
    releaseReplies(); calls.length = 0;
    await page.run((settings, profiles) => {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem("quoridor.prefs.v1", JSON.stringify({ engineRed: "ab:4:350", engineBlue: "ext:default", speed: 0.05, theme: "dark", ...settings }));
      localStorage.setItem("quoridor.external.v2", JSON.stringify({ profiles }));
      window.quoridor = null;
    }, settings, profiles);
    await page.send("Page.reload"); await page.wait(() => !!window.quoridor);
  };
  const humanMove = (action = 67) => page.run((action) => { if (!quoridor.move(action)) throw Error("Human test move rejected"); }, action);
  const save = (enabled, model) => page.run((enabled, model) => {
    document.querySelector("#extAllowMoves").checked = enabled;
    if (model) document.querySelector("#extModel").value = model;
    document.querySelector("#btnExtSave").click();
  }, enabled, model);
  const ply = () => page.run(() => quoridor.state().ply);
  const moveCount = () => calls.filter((item) => item.kind === "move").length;

  await fresh({}, [{}, {}]);
  assert.equal(await page.run(() => document.querySelector("#extAllowMoves").disabled), false);
  await humanMove(); await page.wait(() => document.querySelector("#status").textContent === "Set up external AI");
  await page.run(() => document.querySelector("#btnExternalSetup").click());
  assert.equal(await page.run(() => document.activeElement.id), "extBase");
  assert.equal(await ply(), 1); assert.equal(calls.length, 0);
  console.log("PASS: unconfigured seat waits and opens setup; consent can be selected before the first save");

  await fresh(); await humanMove();
  await page.wait(() => document.querySelector("#status").textContent === "External AI needs permission");
  await sleep(1300);
  assert.equal(await ply(), 1); assert.equal(calls.length, 0);
  assert.equal(await page.run(() => window.__workerStarts), 0);
  await page.run(() => document.querySelector("#btnExternalSetup").click());
  assert.equal(await page.run(() => document.activeElement.id), "extAllowMoves");
  await page.run(() => document.querySelector("#btnExtTest").click());
  await page.wait(() => !document.querySelector("#btnExtTest").disabled);
  assert.equal(calls.at(-1).kind, "test");
  await page.run(() => { document.querySelector("#chatInput").value = "How should I play?"; document.querySelector("#btnChatSend").click(); });
  await page.wait(() => !document.querySelector("#btnChatSend").disabled);
  assert.equal(calls.at(-1).kind, "chat"); assert.equal(await ply(), 1);
  await page.run(() => { document.querySelector("#extAllowMoves").checked = true; });
  await sleep(100); assert.equal(moveCount(), 0);
  await save(true); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 1); assert.equal(calls.at(-1).origin, origin);
  assert.match(await page.run(() => document.querySelector("#chatLog").textContent), /PROMPT CACHE 7 TOK/);
  console.log("PASS: unchecked seat never searches or moves; explicit Test/chat work; Save resumes through a cross-origin localhost API");

  await page.run(() => document.querySelector("#btnUndo").click());
  await humanMove(); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 1);
  assert.match(await page.run(() => document.querySelector("#chatLog").textContent), /RESULT CACHE/);
  await page.run(() => document.querySelector("#btnUndo").click());
  await humanMove(75); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 2);
  for (const [field, value] of [["extModel", "other-model"], ["extKey", "test-only-key"], ["extBase", apiOrigin + "/alternate/v1"], ["extProtocol", "responses"]]) {
    await page.run((field, value) => { document.querySelector("#" + field).value = value; document.querySelector("#btnExtSave").click(); quoridor.newGame(); }, field, value);
    const before = moveCount(); await humanMove(); await page.wait(() => quoridor.state().ply === 2);
    assert.equal(moveCount(), before + 1);
  }
  console.log("PASS: identical context reuses a validated move; changed board, model, key, endpoint and format do not reuse it");

  for (const protocol of ["responses", "anthropic"]) {
    await fresh({}, [{}, { ...profile(true), protocol }]);
    await humanMove(); await page.wait(() => quoridor.state().ply === 2);
    assert.equal(moveCount(), 1);
    assert.ok(calls[0].url.endsWith(protocol === "responses" ? "/responses" : "/messages"));
    if (protocol === "responses") assert.equal(calls[0].body.store, false);
  }
  console.log("PASS: automatic moves work with Chat Completions, Responses and Anthropic Messages");
  await fresh({}, [{}, profile(true)]);
  await page.run(() => { document.querySelector("#btnExtToggle").click(); document.querySelector("#extEffort").value = "max"; document.querySelector("#btnExtSave").click(); });
  await humanMove(); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(calls.at(-1).body.reasoning_effort, "max");
  await page.run(() => { window.quoridor = null; });
  await page.send("Page.reload"); await page.wait(() => !!window.quoridor);
  assert.equal(await page.run(() => document.querySelector("#extEffort").value), "max");
  console.log("PASS: selected Effort is included in the request and persists across a reload");

  await fresh({}, [{}, { ...profile(true), baseUrl: apiOrigin + "/blocked/v1" }]);
  await humanMove();
  await page.wait(() => document.querySelector("#status").textContent === "External AI request failed");
  assert.equal(await ply(), 1); assert.equal(moveCount(), 0);
  assert.equal(await page.run(() => window.__workerStarts), 0);
  assert.match(await page.run(() => document.querySelector("#hint").textContent), /CORS.*preflight/);
  console.log("PASS: a real browser preflight rejection sends no API POST and leaves the board alone");

  await fresh({}, [{}, profile(true, "failed-model")]);
  await humanMove();
  await page.wait(() => document.querySelector("#status").textContent === "External AI request failed");
  await sleep(100);
  assert.equal(await ply(), 1, "failed external move must leave the board unchanged");
  assert.equal(moveCount(), 1);
  assert.equal(await page.run(() => window.__workerStarts), 0, "failed external move must not start local Alpha-beta");
  assert.equal(await page.run(() => document.querySelector("#btnRetryAI").hidden), false);
  assert.match(await page.run(() => document.querySelector("#hint").textContent), /HTTP 503/);
  await page.run(() => document.querySelector("#btnRetryAI").click());
  await page.wait(() => document.querySelector("#status").textContent === "External AI request failed" && !document.querySelector("#btnRetryAI").hidden);
  assert.equal(await ply(), 1); assert.equal(moveCount(), 2);
  await save(true, "mock-model");
  await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 3);
  console.log("PASS: external move failures leave the board unchanged and Retry calls the external endpoint again");

  await fresh({}, [{}, profile(true)]);
  await page.run(() => { quoridor.move(67); setTimeout(() => { document.querySelector("#extAllowMoves").checked = false; document.querySelector("#btnExtSave").click(); }, 10); });
  await page.wait(() => document.querySelector("#status").textContent === "External AI needs permission");
  await sleep(100); assert.equal(await ply(), 1); assert.equal(moveCount(), 0);
  await save(true, "delayed-move");
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  await save(false); releaseReplies(); await sleep(100);
  assert.equal(await ply(), 1); assert.equal(await page.run(() => window.__workerStarts), 0);
  await save(true, "new-model"); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(calls.at(-1).model, "new-model");
  console.log("PASS: revoking consent cancels both delayed starts and in-flight moves without a fallback move");

  await fresh({}, [{}, profile(false, "delayed-chat")]);
  await page.run(() => { document.querySelector("#chatInput").value = "Old conversation"; document.querySelector("#btnChatSend").click(); });
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  await save(false, "new-chat-model");
  assert.equal(await page.run(() => document.querySelector("#btnChatSend").disabled), false);
  releaseReplies();
  await page.run(() => { document.querySelector("#chatInput").value = "New conversation"; document.querySelector("#btnChatSend").click(); });
  await page.wait(() => !document.querySelector("#btnChatSend").disabled);
  const chat = await page.run(() => document.querySelector("#chatLog").textContent);
  assert.match(chat, /Reply from new-chat-model/); assert.doesNotMatch(chat, /Old conversation|Reply from delayed-chat/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /Old conversation/);
  console.log("PASS: changing model cancels the old chat, clears its context and immediately permits a new conversation");

  await fresh({ mode: "ai_ai", engineRed: "ext:default" }, [profile(), profile()]);
  await page.wait(() => document.querySelector("#status").textContent === "External AI needs permission");
  assert.equal(await page.run(() => document.querySelector("#btnPlay").textContent), "Play");
  assert.equal(await page.run(() => document.querySelector("#extSeat").value), "0");
  await save(true); await sleep(100); assert.equal(await ply(), 0);
  await page.run(() => document.querySelector("#btnPlay").click());
  await page.wait(() => quoridor.state().ply === 1 && document.querySelector("#status").textContent === "External AI needs permission");
  assert.equal(await page.run(() => document.querySelector("#extSeat").value), "1");
  assert.equal(moveCount(), 1);
  console.log("PASS: AI-vs-AI pauses, selects the correct profile, and requires Play after permission is saved");

  await fresh({ mode: "ai_ai", humanSide: 1, opponentSeat: 1, engineRed: "ext:default", speed: 1 }, [profile(true), profile(true)]);
  await page.wait(() => quoridor.state().ply === 1);
  await page.run(() => { document.querySelector("#btnPlay").click(); quoridor.setMode("ai"); });
  await page.wait(() => quoridor.state().ply === 1);
  assert.equal(moveCount(), 2);
  assert.doesNotMatch(await page.run(() => document.querySelector("#chatLog").textContent), /RESULT CACHE/);
  console.log("PASS: identical board, model and endpoint never share a move result between logical profiles");

  await fresh({ humanSide: 1, opponentSeat: 1 }, [{}, profile()]);
  await page.wait(() => document.querySelector("#status").textContent === "External AI needs permission");
  assert.equal(await page.run(() => document.querySelector("#extSeat").value), "1");
  assert.equal(await ply(), 0); assert.equal(calls.length, 0);
  console.log("PASS: flipped opponent retains its logical profile and waits for that profile's consent");

  await fresh({ mode: "hotseat" });
  await page.run(() => {
    const context = document.querySelector("#board").getContext("2d"), fillText = context.fillText.bind(context);
    window.roomLabels = [];
    context.fillText = (text, x, y, ...args) => { roomLabels.push({ text, x, y }); return fillText(text, x, y, ...args); };
    class Events {
      constructor() { this.events = {}; this.open = true; this.sent = []; }
      on(name, fn) { (this.events[name] ||= []).push(fn); }
      off(name, fn) { this.events[name] = (this.events[name] || []).filter((item) => item !== fn); }
      emit(name, value) { for (const fn of this.events[name] || []) fn(value); }
      send(value) { this.sent.push(value); }
      close() { this.open = false; this.emit("close"); }
    }
    window.Peer = class extends Events {
      connect() { return window.roomChannel = new Events(); }
      destroy() { this.destroyed = true; }
    };
    quoridor.setMode("room"); document.querySelector("#joinCode").value = "ABCD"; document.querySelector("#btnJoin").click();
  });
  await page.wait(() => !!window.roomChannel);
  await page.run(() => roomChannel.emit("data", { t: "sync", moves: [67] }));
  const roomRows = () => page.run(() => roomLabels.filter((label) => /^[1-9]$/.test(label.text)).slice(-9).map((label) => label.text));
  assert.deepEqual(await roomRows(), ["9", "8", "7", "6", "5", "4", "3", "2", "1"]);
  await page.run(() => {
    const labels = roomLabels.slice(-18), col = labels.find((label) => label.text === "e"), row = labels.find((label) => label.text === "2");
    const board = document.querySelector("#board"), rect = board.getBoundingClientRect();
    board.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + col.x, clientY: rect.top + row.y }));
  });
  assert.equal(await page.run(() => quoridor.state().pos[1]), 13);
  assert.deepEqual(await page.run(() => roomChannel.sent.at(-1)), { t: "move", a: 13, ply: 1 });
  await page.run(() => document.querySelector("#viewBottom").click());
  assert.deepEqual(await roomRows(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(await ply(), 2);
  await page.run(() => { document.querySelector("#viewBottom").click(); roomChannel.emit("data", { t: "sync", moves: [67, 13, 58] }); });
  await page.run(() => {
    const labels = roomLabels.slice(-18), columns = labels.filter((label) => /^[a-i]$/.test(label.text)), rows = labels.filter((label) => /^[1-9]$/.test(label.text));
    const cell = columns[1].x - columns[0].x;
    document.querySelector('[data-tool="H"]').click();
    const board = document.querySelector("#board"), rect = board.getBoundingClientRect();
    board.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + columns[0].x + 4.5 * cell, clientY: rect.top + rows[0].y + 3.5 * cell }));
  });
  assert.equal(await page.run(() => quoridor.state().last), 116);
  assert.equal(await page.run(() => roomChannel.sent.at(-1).a), 116);
  await page.run(() => document.querySelector("#btnCreate").click());
  await page.wait(() => document.querySelector("#status").textContent === "Waiting for an opponent");
  assert.deepEqual(await roomRows(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  console.log("PASS: room guest plays from the bottom; pawn/wall clicks keep canonical network actions; host orientation and toggling work");

  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await page.run(() => quoridor.setMode("hotseat"));
  await page.run(() => {
    const canvas = document.querySelector("#board");
    window.__canvasSizeChanges = 0;
    new MutationObserver((records) => { window.__canvasSizeChanges += records.length; })
      .observe(canvas, { attributes: true, attributeFilter: ["width", "height", "style"] });
  });
  const beforeShortViewport = await page.run(() => ({ width: document.querySelector("#board").width,
    height: document.querySelector("#board").height, cssWidth: document.querySelector("#board").style.width,
    cssHeight: document.querySelector("#board").style.height }));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 500, deviceScaleFactor: 2, mobile: true });
  await sleep(100);
  const afterShortViewport = await page.run(() => ({ width: document.querySelector("#board").width,
    height: document.querySelector("#board").height, cssWidth: document.querySelector("#board").style.width,
    cssHeight: document.querySelector("#board").style.height, mutations: window.__canvasSizeChanges }));
  assert.deepEqual(afterShortViewport, { ...beforeShortViewport, mutations: 0 }, JSON.stringify({ beforeShortViewport, afterShortViewport }));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(80);
  const mobilePoints = await page.run(() => {
    const button = document.querySelector('[data-tool="H"]').getBoundingClientRect();
    const vertical = document.querySelector('[data-tool="V"]').getBoundingClientRect();
    const board = document.querySelector("#board").getBoundingClientRect();
    const cell = Math.round(board.width / 10.48), margin = Math.floor(cell * .74);
    const at = (gx, gy) => ({ x: board.left + margin + gx * cell, y: board.top + margin + gy * cell });
    return { start: { x: button.left + button.width / 2, y: button.top + button.height / 2 },
      startV: { x: vertical.left + vertical.width / 2, y: vertical.top + vertical.height / 2 },
      legalH: at(4.5, 3.5), overlapH: at(5.5, 3.5), outside: { x: board.right + 35, y: board.top + board.height / 2 }, legalV: at(1.5, 4.5) };
  });
  await touchDrag(page, mobilePoints.start, mobilePoints.legalH);
  assert.equal(await ply(), 1);
  assert.equal(await page.run(() => quoridor.state().last), 81 + 3 * 8 + 4);
  await touchDrag(page, mobilePoints.start, mobilePoints.overlapH);
  assert.equal(await ply(), 1, "overlapping wall drag must not play");
  await touchDrag(page, mobilePoints.start, mobilePoints.outside);
  assert.equal(await ply(), 1, "release outside the board must cancel");
  await touchDrag(page, mobilePoints.startV, mobilePoints.legalV);
  assert.equal(await ply(), 2);
  assert.equal(await page.run(() => quoridor.state().last), 145 + 4 * 8 + 1);
  const phone = await page.run(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth,
    touchAction: getComputedStyle(document.querySelector('[data-tool="H"]')).touchAction,
    boardTouchAction: getComputedStyle(document.querySelector("#board")).touchAction,
    target: document.querySelector('[data-tool="H"]').getBoundingClientRect().height }));
  assert.ok(phone.scroll <= phone.width, JSON.stringify(phone)); assert.equal(phone.touchAction, "none");
  assert.equal(phone.boardTouchAction, "manipulation"); assert.ok(phone.target >= 44);
  console.log("PASS: real mobile touch drag places both orientations; overlap/outside releases cancel; touch targets/layout are valid");
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  for (const width of [320, 390, 768, 1280]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    const layout = await page.run(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, helpClosed: !document.querySelector(".ext-help").open, apiLabel: document.querySelector('label[for="extKey"]').textContent }));
    assert.ok(layout.scroll <= layout.width, JSON.stringify(layout)); assert.equal(layout.helpClosed, true); assert.equal(layout.apiLabel, "API KEY");
  }
  await fresh({ engineBlue: "ab:4:350" }); await humanMove();
  await page.wait(() => quoridor.state().ply === 2);
  assert.equal(calls.length, 0); assert.equal(await page.run(() => document.querySelector("#btnExternalSetup").hidden), true);
  assert.deepEqual(errors, []);
  console.log("PASS: compact help fits mobile/desktop, local engines work, and no browser exceptions occurred");
  for (const width of [1200, 390]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 });
    await page.send("Page.navigate", { url: origin + "/quoridor/guide.html" });
    await page.wait(() => document.readyState === "complete" && !!document.querySelector(".guide-examples"));
    const guide = await page.run(async () => {
      const figures = [...document.querySelectorAll(".guide-figure img")];
      for (const image of figures) image.loading = "eager";
      await Promise.all(figures.map((image) => image.decode()));
      const firstExamples = [...document.querySelector(".guide-examples").children].map((element) => Math.round(element.getBoundingClientRect().top));
      return { sizes: figures.map((image) => [image.naturalWidth, image.naturalHeight, Number(image.getAttribute("width")), Number(image.getAttribute("height"))]), firstExamples,
        width: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    assert.equal(guide.sizes.length, 5);
    for (const [width, height, specifiedWidth, specifiedHeight] of guide.sizes) assert.deepEqual([width, height], [specifiedWidth, specifiedHeight]);
    assert.equal(guide.firstExamples[0] === guide.firstExamples[1], width >= 560);
    assert.ok(guide.scroll <= guide.width);
  }
  console.log("PASS: all five Guide screenshots load at their stated sizes and fit desktop and mobile");
} finally {
  releaseReplies(); page?.ws.close();
  if (browserContextId) await browser.send("Target.disposeBrowserContext", { browserContextId });
  browser?.ws.close();
  site.closeAllConnections(); api.closeAllConnections();
  await Promise.all([new Promise((resolve) => site.close(resolve)), new Promise((resolve) => api.close(resolve))]);
}
