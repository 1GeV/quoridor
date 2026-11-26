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
  const turns = messages.map(({ role, content }) => ({ role, content: typeof content === "string" ? content : content[0]?.text }));
  const system = body.instructions ?? body.system?.[0]?.text ?? turns.find((message) => ["system", "developer"].includes(message.role))?.content;
  const image = Array.isArray(messages.at(-1)?.content) ? messages.at(-1).content.find((part) =>
    ["image_url", "input_image", "image"].includes(part.type)) : null;
  const last = image ? turns.slice(0, -1).findLast((turn) => turn.role === "user")?.content : turns.at(-1)?.content;
  const board = last?.startsWith("{") ? JSON.parse(last) : null;
  const kind = image ? "image" : board?.task ?? "test";
  const call = { kind, board, turns, system, image, model: body.model, body, url: req.url, origin: req.headers.origin };
  calls.push(call);
  if (String(body.model).startsWith("failed")) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "mock unavailable" }));
    return;
  }
  const reply = () => {
    if (res.destroyed) return;
    res.setHeader("Content-Type", "application/json");
    const requests = turns.filter((turn) => turn.role === "user" && turn.content.startsWith("{")).map((turn) => JSON.parse(turn.content));
    const preference = requests.findLast((request) => /prefer a (wall|pawn)/.test(request.message))?.message;
    const move = board?.legalActions[0];
    const preferred = preference?.includes("prefer a wall") ? board.legalActions.find((action) => /^[HV] /.test(action)) : move;
    const text = kind === "test" ? "OK" : kind === "chat" ? `Reply from ${body.model}.`
      : kind === "move" && body.model === "ask-image" ? '{"want_board":true}' : JSON.stringify({ move: preferred });
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
  const sendMessage = (text) => page.run((text) => {
    const send = document.querySelector("#btnChatSend");
    if (send.disabled || send.textContent !== "Send") throw Error("Chat send was unavailable");
    document.querySelector("#chatInput").value = text;
    send.click();
  }, text);
  const chatReady = () => page.wait(() => {
    const send = document.querySelector("#btnChatSend");
    return !send.disabled && send.textContent === "Send";
  });
  const chatLog = () => page.run(() => document.querySelector("#chatLog").textContent);

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
  await page.wait(() => document.querySelector("#btnExtTest").textContent === "Test");
  assert.equal(calls.at(-1).kind, "test");
  await sendMessage("Please prefer a wall."); await chatReady();
  const openingChat = calls.at(-1);
  assert.equal(openingChat.kind, "chat"); assert.equal(await ply(), 1);
  await page.run(() => { document.querySelector("#extAllowMoves").checked = true; });
  await sleep(100); assert.equal(moveCount(), 0);
  await save(true); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 1); assert.equal(calls.at(-1).origin, origin);
  const openingMove = calls.at(-1);
  assert.equal(openingMove.system, openingChat.system);
  assert.match(openingMove.system, /Both are optional/);
  assert.deepEqual(openingMove.turns.slice(0, openingChat.turns.length), openingChat.turns);
  assert.match(await chatLog(), /PROMPT CACHE 7 TOK.*[HV] [a-h][1-8]/);
  assert.equal(await page.run(() => quoridor.state().walls[1]), 9);
  console.log("PASS: unchecked seat never searches or moves; explicit Test/chat work; Save resumes through a cross-origin localhost API");

  await page.run(() => document.querySelector("#btnUndo").click());
  await humanMove(); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 1);
  assert.match(await page.run(() => document.querySelector("#chatLog").textContent), /RESULT CACHE/);
  await page.run(() => document.querySelector("#btnUndo").click());
  await humanMove(75); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 2);
  const secondMove = calls.at(-1);
  await sendMessage("Now prefer a pawn move."); await chatReady();
  const followup = calls.at(-1);
  assert.deepEqual(followup.turns.slice(0, secondMove.turns.length), secondMove.turns);
  const bareMove = JSON.parse(followup.turns.at(-2).content);
  assert.deepEqual(Object.keys(bareMove), ["move"]);
  assert.deepEqual(followup.board.placedWalls, [bareMove.move]);
  await page.run(() => document.querySelector("#btnExtTest").click());
  await page.wait(() => document.querySelector("#btnExtTest").textContent === "Test");
  assert.equal(calls.at(-1).kind, "test");
  assert.doesNotMatch(JSON.stringify(calls.at(-1).turns), /prefer a/);
  await page.run(() => document.querySelector("#btnUndo").click());
  await humanMove(75); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 3);
  assert.match(JSON.stringify(calls.at(-1).turns), /Now prefer a pawn move/);
  assert.equal(calls.at(-1).turns.filter((turn) => turn.role === "assistant").length, 2);
  assert.equal(await page.run(() => quoridor.state().walls[1]), 10);
  await page.run(() => document.querySelector("#btnChatClear").click());
  await page.run(() => document.querySelector("#btnUndo").click());
  await humanMove(75); await page.wait(() => quoridor.state().ply === 2);
  assert.equal(moveCount(), 4);
  assert.equal(calls.at(-1).turns.length, 2);
  console.log("PASS: chat affects automatic moves, a bare move feeds later chat, undo keeps strategy, and clear resets history");
  for (const [field, value] of [["extModel", "other-model"], ["extKey", "test-only-key"], ["extBase", apiOrigin + "/alternate/v1"], ["extProtocol", "responses"]]) {
    await page.run((field, value) => { document.querySelector("#" + field).value = value; document.querySelector("#btnExtSave").click(); quoridor.newGame(); }, field, value);
    const before = moveCount(); await humanMove(); await page.wait(() => quoridor.state().ply === 2);
    assert.equal(moveCount(), before + 1);
  }
  console.log("PASS: identical context reuses a validated move; changed board, model, key, endpoint and format do not reuse it");

  for (const protocol of ["responses", "anthropic"]) {
    await fresh({}, [{}, { ...profile(true), protocol }]);
    await sendMessage("Please prefer a wall."); await chatReady();
    await humanMove(); await page.wait(() => quoridor.state().ply === 2);
    assert.equal(moveCount(), 1);
    const [question, move] = calls;
    assert.ok(move.url.endsWith(protocol === "responses" ? "/responses" : "/messages"));
    assert.equal(move.system, question.system);
    assert.deepEqual(move.turns.slice(0, question.turns.length), question.turns);
    assert.equal(await page.run(() => quoridor.state().walls[1]), 9);
    await sendMessage("How did that move follow the plan?"); await chatReady();
    const discussion = calls.at(-1);
    assert.equal(discussion.system, move.system);
    assert.deepEqual(discussion.turns.slice(0, move.turns.length), move.turns);
    assert.equal(discussion.board.movesPlayed, 2);
    assert.deepEqual(discussion.board.placedWalls, [JSON.parse(discussion.turns.at(-2).content).move]);
    if (protocol === "responses") {
      for (const call of [question, move, discussion]) {
        assert.equal(call.body.store, false);
        assert.equal(call.body.previous_response_id, undefined);
        assert.deepEqual(call.body.input[0], { role: "developer", content: question.system });
        assert.equal(call.body.instructions, undefined);
      }
    } else {
      for (const call of [question, move, discussion]) {
        assert.equal(call.body.messages.at(-1).content[0].cache_control.type, "ephemeral");
        assert.ok(call.body.messages.slice(0, -1).every((message) => !message.content[0].cache_control));
      }
    }
    assert.match(await chatLog(), /PROMPT CACHE 7 TOK/);
  }
  console.log("PASS: automatic moves and chat share stable prefixes and display reported hits across all three API formats");

  await fresh();
  for (let i = 0; i < 15; i++) {
    await sendMessage(`Strategy message ${i}.`);
    await chatReady();
  }
  const chatRequests = calls.map((call) => call.turns);
  assert.equal(chatRequests[12].length, 26);
  assert.equal(chatRequests[13].length, 20);
  assert.doesNotMatch(JSON.stringify(chatRequests[13]), /Strategy message 0\./);
  assert.deepEqual(chatRequests[14].slice(0, chatRequests[13].length), chatRequests[13]);
  console.log("PASS: history stays bounded and resumes stable prefixes after trimming");

  for (const protocol of ["chat", "responses", "anthropic"]) {
    await fresh({}, [{}, { ...profile(true, "ask-image"), protocol, allowImage: true }]);
    await humanMove(81);
    await page.wait(() => quoridor.state().ply === 2);
    const [first, followup] = calls;
    assert.equal(calls.length, 2);
    assert.equal(first.kind, "move");
    assert.equal(first.board.boardImageAvailable, true);
    assert.deepEqual(first.board.pawns, { Red: "e9", Blue: "e1" });
    assert.deepEqual(first.board.placedWalls, ["H a1"]);
    assert.deepEqual(first.board.wallsLeft, { Red: 9, Blue: 10 });
    assert.equal(first.board.yourSide, "Blue");
    assert.equal(first.board.sideToMove, "Blue");
    assert.deepEqual(followup.board, first.board);
    assert.equal(followup.kind, "image");
    const image = Buffer.from(followup.image.source?.data ?? (followup.image.image_url?.url ?? followup.image.image_url).split(",")[1], "base64");
    assert.equal(image.readUInt16BE(), 0xffd8);
    assert.deepEqual(followup.turns.slice(0, first.turns.length), first.turns);
    await sendMessage("Describe your move."); await chatReady();
    assert.ok(!calls.at(-1).image);
  }
  await fresh({}, [{}, profile(true, "ask-image")]);
  await humanMove();
  await page.wait(() => document.querySelector("#status").textContent === "External AI request failed");
  assert.equal(await ply(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].board.boardImageAvailable, false);
  console.log("PASS: all three formats can request the current board image before playing, and image sharing requires permission");
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

  await fresh({}, [{}, profile(true, "delayed-ordered")]);
  await sendMessage("Please prefer a wall while your turn starts.");
  await humanMove();
  await page.wait(() => document.querySelector("#hint").textContent === "Waiting for the chat reply");
  assert.equal(moveCount(), 0);
  releaseReplies();
  await page.wait(() => document.querySelector("#chatStatus").textContent === "playing");
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  assert.match(JSON.stringify(calls.at(-1).turns), /prefer a wall while your turn starts/);
  releaseReplies();
  await page.wait(() => quoridor.state().ply === 2);
  assert.equal(await page.run(() => quoridor.state().walls[1]), 9);
  console.log("PASS: an automatic turn waits for an earlier chat request on the same seat");

  await fresh({}, [{}, profile(true, "delayed-cancel")]);
  await page.run(() => {
    document.querySelector("#btnExtToggle").click();
    document.querySelector("#btnExtTest").click();
  });
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  await page.run(() => document.querySelector("#btnExtTest").click());
  await page.wait(() => document.querySelector("#extNote").textContent === "Test cancelled.");
  releaseReplies();
  await sendMessage("Please prefer a wall, then cancel this request.");
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  await page.run(() => document.querySelector("#btnChatSend").click());
  await chatReady(); releaseReplies();
  assert.doesNotMatch(await chatLog(), /prefer a wall/);
  await humanMove();
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).turns), /prefer a wall/);
  assert.equal(await page.run(() => document.querySelector("#btnRetryAI").textContent), "Cancel AI move");
  await page.run(() => document.querySelector("#btnRetryAI").click());
  releaseReplies(); await sleep(100);
  assert.equal(await ply(), 1);
  assert.equal(await page.run(() => document.querySelector("#btnRetryAI").textContent), "Retry AI move");
  await page.run(() => document.querySelector("#btnRetryAI").click());
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  releaseReplies(); await page.wait(() => quoridor.state().ply === 2);
  console.log("PASS: Test, chat and moves can all be cancelled; cancelled turns leave no history or move result");

  await fresh({}, [{}, profile(false, "delayed-chat")]);
  await sendMessage("Old conversation");
  for (let i = 0; i < 100 && !delayed.length; i++) await sleep(20);
  assert.equal(delayed.length, 1);
  await save(false, "new-chat-model");
  assert.equal(await page.run(() => document.querySelector("#btnChatSend").disabled), false);
  releaseReplies();
  await page.run(() => { document.querySelector("#chatInput").value = "New conversation"; document.querySelector("#btnChatSend").click(); });
  await chatReady();
  const chat = await page.run(() => document.querySelector("#chatLog").textContent);
  assert.match(chat, /Reply from new-chat-model/); assert.doesNotMatch(chat, /Old conversation|Reply from delayed-chat/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /Old conversation/);
  console.log("PASS: changing model cancels the old chat, clears its context and immediately permits a new conversation");

  await fresh({ mode: "ai_ai", engineRed: "ext:default" }, [profile(), profile()]);
  await page.wait(() => document.querySelector("#status").textContent === "External AI needs permission");
  assert.equal(await page.run(() => document.querySelector("#btnPlay").textContent), "Play");
  assert.equal(await page.run(() => document.querySelector("#extSeat").value), "0");
  const selectSeat = (seat) => page.run((seat) => {
    const select = document.querySelector("#extSeat");
    select.value = seat;
    select.dispatchEvent(new Event("change"));
  }, seat);
  await selectSeat("1"); await sendMessage("Blue strategy only"); await chatReady();
  await selectSeat("0"); await sendMessage("Please prefer a wall as Red"); await chatReady();
  await save(true); await sleep(100); assert.equal(await ply(), 0);
  await page.run(() => document.querySelector("#btnPlay").click());
  await page.wait(() => quoridor.state().ply === 1 && document.querySelector("#status").textContent === "External AI needs permission");
  assert.equal(await page.run(() => document.querySelector("#extSeat").value), "1");
  assert.equal(moveCount(), 1);
  assert.match(JSON.stringify(calls.at(-1).turns), /Please prefer a wall as Red/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).turns), /Blue strategy only/);
  assert.match(await chatLog(), /Blue strategy only/);
  assert.doesNotMatch(await chatLog(), /Please prefer a wall as Red/);
  console.log("PASS: AI-vs-AI keeps separate conversations, selects the correct profile, and requires Play after saving permission");

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
      constructor() {
        super();
        this.open = false;
        window.roomPeer = this;
        if (window.roomPeerStalls) return;
        queueMicrotask(() => {
          if (this.destroyed) return;
          this.open = true;
          this.emit("open", "test-peer-id");
        });
      }
      connect() { return window.roomChannel = new Events(); }
      destroy() { this.destroyed = true; this.close(); }
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
  console.log("PASS: room creation and joining wait for signalling; room moves and orientation work");

  await page.run(() => {
    window.roomPeerStalls = true;
    window.normalRoomTestTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => normalRoomTestTimeout(callback, delay === 12000 ? 30 : delay, ...args);
    document.querySelector("#btnCreate").click();
  });
  await page.wait(() => document.querySelector("#status").textContent === "Could not create a room");
  assert.equal(await page.run(() => document.querySelector("#roomMsg").textContent), "Room server did not respond");
  assert.deepEqual(await page.run(() => ({ destroyed: roomPeer.destroyed, listeners: Object.values(roomPeer.events).flat().length })),
    { destroyed: true, listeners: 0 });
  await page.run(() => {
    window.setTimeout = normalRoomTestTimeout;
    window.roomPeerStalls = false;
    document.querySelector("#btnCreate").click();
  });
  await page.wait(() => document.querySelector("#status").textContent === "Waiting for an opponent");
  console.log("PASS: stalled room creation times out, releases signalling listeners, and can be retried");

  const redWin = [67, 81, 58, 5, 49, 6, 40, 7, 31, 8, 22, 17, 13, 26, 4];
  const blueWin = [75, 13, 74, 22, 73, 31, 72, 40, 63, 49, 54, 58, 45, 67, 36, 76];
  const result = () => page.run(() => {
    const get = (id) => document.getElementById(id);
    const dialog = get("resultDialog");
    return {
      open: dialog.open, outcome: dialog.dataset.outcome, title: get("resultTitle").textContent,
      description: get("resultDescription").textContent,
      rematchNotice: get("roomRematch").hidden ? "" : get("roomRematch").textContent,
      restartAction: get("btnNew").textContent,
      players: get("resultMatchup").textContent, status: get("status").textContent, winner: get("resultWinner").textContent,
      moves: Number(get("resultMoves").textContent), walls: Number(get("resultWalls").textContent),
      newGame: get("btnResultNew").textContent, canRestart: !get("btnResultNew").disabled,
      canReview: !get("btnResultReview").hidden, canUndo: !get("btnResultUndo").hidden,
      viewResult: !get("btnResult").hidden, canFlip: !get("btnFlip").disabled, autoplay: !get("btnPlay").hidden,
    };
  });
  await page.run((line) => {
    const channel = new roomChannel.constructor();
    window.hostResultChannel = channel;
    roomPeer.emit("connection", channel);
    line.forEach((a, ply) => {
      if (ply % 2 === 0) { if (!quoridor.move(a)) throw Error("Invalid host move " + a); }
      else channel.emit("data", { t: "move", a, ply });
    });
  }, redWin);
  const hostWin = await result();
  assert.equal(hostWin.title, "You won!");
  assert.equal(hostWin.open, true);
  assert.equal(hostWin.canUndo, false);
  assert.equal(hostWin.canReview, false);
  await page.run(() => hostResultChannel.emit("data", { t: "askRestart" }));
  const hostRequest = await result();
  assert.equal(hostRequest.open, true);
  assert.equal(hostRequest.newGame, "Accept rematch");
  assert.match(hostRequest.description, /Your opponent requested a rematch/);
  await page.run(() => document.querySelector("#btnResultBoard").click());
  assert.equal((await result()).restartAction, "Accept rematch");
  assert.match((await result()).rematchNotice, /Your opponent requested a rematch/);
  await page.run(() => {
    document.querySelector("#btnNew").click();
    if (hostResultChannel.sent.at(-1)?.moves?.length !== 0) throw Error("New room game was not synchronized");
    document.querySelector("#joinCode").value = "ABCD";
    document.querySelector("#btnJoin").click();
  });
  await page.wait(() => document.querySelector("#roomMsg").textContent === "Connecting to the host." && roomPeer.open);
  await page.run((line) => roomChannel.emit("data", { t: "sync", moves: line }), redWin);
  const guestLoss = await result();
  assert.equal(guestLoss.outcome, "defeat");
  assert.equal(guestLoss.newGame, "Request rematch");
  await page.run(() => {
    const button = document.querySelector("#btnResultNew");
    button.click();
    button.click();
    if (roomChannel.sent.filter((message) => message.t === "askRestart").length !== 1) throw Error("Guest should send exactly one rematch request");
  });
  const waiting = await result();
  assert.equal(waiting.open, true);
  assert.equal(waiting.newGame, "Waiting for host…");
  assert.equal(waiting.canRestart, false);
  assert.match(waiting.description, /Rematch requested\. Waiting for the host/);
  await page.run((line) => {
    document.querySelector("#btnResultBoard").click();
    roomChannel.emit("data", { t: "sync", moves: line });
  }, redWin);
  assert.equal((await result()).open, false, "same result should not reopen on resync");
  assert.match((await result()).rematchNotice, /Rematch requested/);
  await page.run(() => roomChannel.emit("data", { t: "sync", moves: [] }));
  assert.equal(await ply(), 0, "host acceptance starts an empty game");
  assert.equal((await result()).rematchNotice, "");
  assert.equal((await result()).restartAction, "Request rematch");
  await page.run((line) => roomChannel.emit("data", { t: "sync", moves: line }), redWin);
  await page.run(() => document.querySelector("#btnResultBoard").click());
  await page.run(() => roomChannel.close());
  const disconnected = await result();
  assert.equal(disconnected.status, "You lost this round");
  assert.equal(disconnected.canRestart, false);
  assert.equal(disconnected.viewResult, true);
  assert.equal(disconnected.rematchNotice, "");
  console.log("PASS: Room rematch requests are visible in the result and board, wait for host acceptance, then synchronize the new game");

  const finishLine = (line) => page.run((moves) => {
    for (const a of moves) if (!quoridor.move(a)) throw Error("Invalid test move " + a);
  }, line);
  await fresh({ mode: "ai", humanSide: 0, engineBlue: "ab:4:350", saveGames: false });
  await finishLine(redWin);
  const win = await result();
  assert.equal(win.open, true);
  assert.equal(win.outcome, "victory");
  assert.equal(win.title, "You won!");
  assert.equal(win.winner, "Red");
  assert.equal(win.moves, redWin.length);
  assert.equal(win.walls, 1);
  assert.equal(win.canUndo, true);
  await page.run(() => {
    document.querySelector("#btnResultBoard").click();
    document.querySelector("#btnFlip").click();
    const engine = document.querySelector("#engineBlue");
    engine.value = "sigma:64";
    engine.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#btnResult").click();
  });
  const stable = await result();
  assert.equal(stable.outcome, "victory");
  assert.equal(stable.canFlip, false);
  assert.equal(stable.players, win.players);
  await page.run(() => document.querySelector("#btnResultUndo").click());
  assert.equal(await ply(), redWin.length - 1);
  assert.equal((await result()).viewResult, false);
  assert.equal((await result()).canFlip, true);
  await finishLine(redWin.slice(-1));
  assert.equal((await result()).open, true, "undo and finish again should display the result");

  await fresh({ mode: "ai", humanSide: 1, opponentSeat: 0, saveGames: false });
  await finishLine(blueWin);
  assert.equal((await result()).outcome, "victory");
  assert.equal((await result()).winner, "Blue");
  await page.run(() => document.querySelector("#btnResultNew").click());
  await finishLine(redWin);
  assert.equal((await result()).outcome, "defeat");
  console.log("PASS: vs AI reports both colours from the human perspective and preserves result details until undo or restart");

  await fresh({ mode: "hotseat", saveGames: false });
  await finishLine(blueWin);
  const localResult = await result();
  assert.equal(localResult.title, "Blue wins!");
  assert.equal(localResult.players, "Player 1 vs Player 2");
  assert.equal(localResult.canUndo, true);
  await page.run(() => document.querySelector("#btnResultReview").click());
  assert.deepEqual(await page.run(() => ({
    mode: quoridor.mode, dialogOpen: document.querySelector("#resultDialog").open,
    status: document.querySelector("#status").textContent, canContinue: !document.querySelector("#btnContinue").disabled,
  })), { mode: "replay", dialogOpen: false, status: "Blue wins · move 16", canContinue: false });
  await page.run(() => {
    document.querySelector("#btnPrev").click();
    if (document.querySelector("#btnContinue").disabled) throw Error("Earlier replay position cannot continue");
    document.querySelector("#btnNext").click();
  });
  assert.equal((await result()).open, false);
  assert.equal((await result()).viewResult, false);
  console.log("PASS: 2 players can review a completed game without saving, and Replay keeps the result inline");

  await fresh({ mode: "ai_ai", engineBlue: "ab:4:350", saveGames: false, speed: 2.5 });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await finishLine(redWin);
  const aiResult = await result();
  assert.equal(aiResult.title, "Red wins!");
  assert.equal(aiResult.canUndo, false);
  assert.equal(aiResult.canReview, true);
  assert.equal(aiResult.autoplay, false);
  await sleep(300);
  assert.equal(await page.run(() => {
    const rect = document.querySelector("#resultDialog").getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  }), true);
  await page.run(() => document.querySelector("#btnResultNew").click());
  assert.equal(await ply(), 0);
  assert.equal((await result()).autoplay, true);
  assert.equal(await page.run(() => document.querySelector("#btnPlay").textContent), "Pause");
  console.log("PASS: AI vs AI stops on the result, fits a small phone, and can restart autoplay");

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
  await page.run(() => document.querySelector('[data-tool="auto"]').click());
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
  const boardBox = () => { const rect = document.querySelector("#board").getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; };
  const boardBeforeMove = await page.run(boardBox);
  const tapPoint = await page.run(() => {
    const board = document.querySelector("#board");
    if (getComputedStyle(board).webkitTapHighlightColor !== "rgba(0, 0, 0, 0)") throw Error("Canvas has a native tap highlight");
    const rect = board.getBoundingClientRect();
    const cell = Math.round(rect.width / 10.48), margin = Math.floor(cell * .74);
    return { x: rect.left + margin + 4.5 * cell, y: rect.top + margin + 7.5 * cell };
  });
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tapPoint] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.wait(() => quoridor.state().ply === 1);
  assert.equal(await page.run(() => quoridor.state().last), 67);
  assert.deepEqual(await page.run(boardBox), boardBeforeMove);
  await page.run(() => { document.querySelector("#aiLoading").hidden = false; });
  assert.deepEqual(await page.run(boardBox), boardBeforeMove, "AI progress must not move the board");
  await page.run(() => { document.querySelector("#aiLoading").hidden = true; quoridor.setMode("hotseat"); });
  console.log("PASS: mobile pawn tap remains legal without a native tint; board position is stable during progress");
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

  await fresh({ mode: "ai", engineBlue: "sigma:64" });
  await humanMove();
  const waitForLocalMoves = async (count) => {
    const deadline = Date.now() + 30000;
    let report;
    do {
      report = await page.run(() => ({
        ply: quoridor.state().ply,
        status: document.querySelector("#status").textContent,
        hint: document.querySelector("#hint").textContent,
      }));
      if (report.ply >= count || report.status === "AI engine failed") break;
      await sleep(50);
    } while (Date.now() < deadline);
    return report;
  };
  const humanVsSigma = await waitForLocalMoves(2);
  assert.equal(humanVsSigma.ply, 2, JSON.stringify(humanVsSigma));
  assert.equal(await page.run(() => quoridor.metrics().engine), "sigma");
  await fresh({ mode: "ai_ai", engineRed: "sigma:64", engineBlue: "champion:6:1200" });
  const sigmaVsChampion = await waitForLocalMoves(4);
  assert.ok(sigmaVsChampion.ply >= 4, JSON.stringify(sigmaVsChampion));
  assert.equal(calls.length, 0);
  assert.deepEqual(errors, []);
  console.log("PASS: Sigma starts a cold runtime in VS AI and alternates with Claustrophobia in AI vs AI");

  const { identifier: simulateGpuLoss } = await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${() => {
      Object.defineProperty(navigator, "gpu", { value: {} });
      const RealWorker = window.Worker;
      window.Worker = class extends RealWorker {
        constructor(url, ...options) {
          if (!new URL(url, location.href).pathname.endsWith("/sigma-gpu-worker.js")) {
            super(url, ...options);
            return;
          }
          // Pass the two startup probes, then mimic a GPU failure during play.
          const reply = ({ data: { id, type, batch } }) => {
            if (type === "probe") postMessage({ id, result: true });
            else if (type === "load") postMessage({ id });
            else if (++calls > 2) postMessage({ id, error: "Test GPU lost" });
            else postMessage({ id, result: { logits: new Float32Array(batch * 136), values: new Float32Array(batch) } });
          };
          const blob = URL.createObjectURL(new Blob(["let calls = 0; onmessage = " + reply], { type: "text/javascript" }));
          super(blob, ...options);
          URL.revokeObjectURL(blob);
        }
      };
    }})()`,
  });
  await fresh({ mode: "ai", engineBlue: "sigma:64" });
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: simulateGpuLoss });
  await humanMove();
  const gpuRecovery = await waitForLocalMoves(2);
  assert.equal(gpuRecovery.ply, 2, JSON.stringify(gpuRecovery));
  assert.match(gpuRecovery.hint, /Sigma.*CPU/);
  assert.equal(await page.run(() => quoridor.metrics().engine), "sigma");
  assert.deepEqual(errors, []);
  console.log("PASS: Sigma retries the same turn on CPU when an initialized GPU fails");

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
