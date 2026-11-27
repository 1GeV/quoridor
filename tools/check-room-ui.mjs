// Exercise both room pages with delayed, ordered delivery and no public relay.
// Requires Edge, or QUORIDOR_BROWSER pointing to another Chromium browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "quoridor-room-test-"));
const executable = process.env.QUORIDOR_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const errors = [];
const site = http.createServer(async (req, res) => {
  const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    }).end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;
const child = spawn(executable, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { windowsHide: true, stdio: "ignore" });
let socket, context;
const pending = new Map();
let sequence = 0;

async function until(check, description) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error("Timed out: " + description);
}

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out: " + method)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function page() {
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId: context });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const run = async (fn, ...args) => {
    const response = await send("Runtime.evaluate", {
      expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: 'localStorage.setItem("quoridor.prefs.v1", JSON.stringify({mode:"hotseat",saveGames:false}));',
  }, sessionId);
  await send("Page.navigate", { url: origin + "/" }, sessionId);
  await until(() => run(() => !!window.quoridor), "game startup");
  await run(() => {
    class Channel {
      constructor() { this.events = {}; this.open = true; this.sent = []; }
      on(event, callback) { (this.events[event] ||= []).push(callback); }
      off(event, callback) { this.events[event] = (this.events[event] || []).filter((item) => item !== callback); }
      emit(event, value) { for (const callback of this.events[event] || []) callback(value); }
      send(message) { this.sent.push(structuredClone(message)); }
      close() { this.open = false; this.emit("close"); }
    }
    window.TestChannel = Channel;
    window.Peer = class extends Channel {
      constructor() {
        super(); this.open = false; window.testPeer = this;
        queueMicrotask(() => { this.open = true; this.emit("open", "room-test"); });
      }
      connect() { return window.testChannel = new Channel(); }
      destroy() { this.close(); }
    };
  });
  return {
    run,
    snapshot: () => run(() => ({
      ...quoridor.state(),
      action: document.querySelector("#btnResultNew").textContent,
      disabled: document.querySelector("#btnResultNew").disabled,
      notice: document.querySelector("#roomRematch").textContent,
      seat: document.querySelector("#roomMsg").textContent,
    })),
    take: () => run(() => testChannel.sent.splice(0)),
    receive: (messages) => run((messages) => {
      for (const message of messages) testChannel.emit("data", message);
    }, messages),
    click: (id) => run((id) => document.getElementById(id).click(), id),
  };
}

try {
  let debug;
  await until(async () => {
    try { debug = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/); return true; }
    catch { return false; }
  }, "headless browser");
  socket = new WebSocket(`ws://127.0.0.1:${debug[0]}${debug[1]}`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  ({ browserContextId: context } = await send("Target.createBrowserContext"));
  const host = await page(), guest = await page();

  async function deliver(from, to, delay = 0) {
    const messages = await from.take();
    if (messages.length && delay) await sleep(delay);
    if (messages.length) await to.receive(messages);
    return messages;
  }
  async function flush(first = host, second = guest) {
    for (let i = 0; i < 8; i++) {
      const one = await deliver(first, second), two = await deliver(second, first);
      if (!one.length && !two.length) return;
    }
    throw new Error("Room messages did not settle");
  }
  async function finished(side = 0) {
    await host.run((side) => {
      quoridor.setMode("room");
      document.querySelector("#roomHostSide").value = String(side);
      document.querySelector("#btnDirectRoom").click();
    }, side);
    await until(() => host.run(() => document.querySelector("#status").textContent === "Waiting for an opponent"), "host creation");
    await host.run(() => {
      window.testChannel = new TestChannel();
      testPeer.emit("connection", testChannel);
    });
    await guest.run(() => {
      quoridor.setMode("room");
      document.querySelector("#joinCode").value = "ABCD";
      document.querySelector("#btnJoin").click();
    });
    await until(() => guest.run(() => !!window.testChannel?.sent.some((message) => message.t === "roomHello")), "guest hello");
    await flush();
    // Finish through normal room moves, including delivery of the final move.
    const line = [67, 81, 58, 5, 49, 6, 40, 7, 31, 8, 22, 17, 13, 26, 4];
    for (let i = 0; i < line.length; i++) {
      const from = i % 2 === side ? host : guest, to = from === host ? guest : host;
      assert.equal(await from.run((action) => quoridor.move(action), line[i]), true);
      await deliver(from, to);
    }
    assert.equal((await host.snapshot()).terminal, true);
    assert.equal((await guest.snapshot()).terminal, true);
  }
  async function restarted(hostSide = 0) {
    const first = await host.snapshot(), second = await guest.snapshot();
    assert.equal(first.terminal, false, JSON.stringify(first));
    assert.equal(first.ply, 0);
    assert.equal(second.terminal, false, JSON.stringify(second));
    assert.equal(second.ply, 0);
    assert.match(first.seat, new RegExp("you are " + (hostSide === 0 ? "Red" : "Blue")));
    assert.match(second.seat, new RegExp("you are " + (hostSide === 0 ? "Blue" : "Red")));
    const red = hostSide === 0 ? host : guest, blue = hostSide === 0 ? guest : host;
    assert.equal(await red.run(() => quoridor.move(67)), true);
    await deliver(red, blue);
    assert.equal(await blue.run(() => quoridor.move(13)), true);
    await deliver(blue, red);
    assert.deepEqual((await host.snapshot()).pos, (await guest.snapshot()).pos);
    assert.equal((await host.snapshot()).ply, 2);
    assert.equal((await guest.snapshot()).ply, 2);
  }

  await finished();
  await host.click("btnResultNew");
  await guest.click("btnResultNew");
  await deliver(host, guest, 250);
  await deliver(guest, host, 250);
  await flush();
  await restarted();
  console.log("PASS: simultaneous same-side requests start one shared round despite delivery delay");

  for (const side of [0, 1]) {
    await finished(side);
    await host.click("btnResultSwap");
    await guest.click("btnResultSwap");
    await flush(guest, host);
    await restarted(1 - side);
  }
  console.log("PASS: simultaneous swap requests agree in the other delivery order with either host colour");

  await finished();
  await host.click("btnResultSwap");
  await guest.click("btnResultNew");
  await flush();
  assert.equal((await host.snapshot()).terminal, true);
  assert.equal((await guest.snapshot()).action, "Accept & swap sides");
  await guest.click("btnResultNew");
  await flush();
  await restarted(1);
  console.log("PASS: different side choices require explicit agreement before resetting");

  await finished();
  await host.click("btnResultNew");
  await guest.click("btnResultNew");
  await guest.click("btnResultSwapDecline");
  await flush();
  assert.equal((await host.snapshot()).terminal, true);
  assert.equal((await guest.snapshot()).action, "Accept rematch");
  await guest.click("btnResultSwapDecline");
  await flush();
  assert.equal((await host.snapshot()).disabled, false);
  assert.equal((await guest.snapshot()).disabled, false);
  console.log("PASS: cancelling while offers cross preserves the choice to accept or decline");

  await finished();
  await host.click("btnResultNew");
  await host.click("btnResultSwapDecline");
  await guest.click("btnResultNew");
  await flush();
  assert.equal((await host.snapshot()).action, "Request rematch");
  assert.equal((await guest.snapshot()).action, "Request rematch");
  assert.equal((await host.snapshot()).terminal, true);
  assert.equal((await guest.snapshot()).terminal, true);
  console.log("PASS: withdrawing a crossed offer cannot leave a request known only to the host");

  await finished();
  await host.click("btnResultNew");
  await host.click("btnResultSwapDecline");
  await guest.click("btnResultNew");
  await deliver(guest, host);
  assert.equal((await host.snapshot()).disabled, true);
  await host.click("btnResultNew");
  assert.equal((await host.snapshot()).terminal, true);
  await deliver(host, guest);
  await flush();
  await guest.click("btnResultNew");
  await deliver(guest, host);
  await host.click("btnResultNew");
  await flush();
  await restarted();
  console.log("PASS: a cancelled host offer settles before either side can request and accept a fresh rematch");

  await finished();
  await guest.click("btnResultNew");
  await deliver(guest, host);
  await host.click("btnResultNew");
  await guest.click("btnResultSwapDecline");
  await deliver(guest, host);
  await deliver(host, guest);
  await restarted();
  console.log("PASS: host acceptance and guest cancellation crossing in transit agree on the committed round");

  await finished();
  await host.click("btnResultNew");
  await guest.click("btnResultNew");
  const oldHostOffer = await deliver(host, guest);
  const guestMessages = await deliver(guest, host);
  await flush();
  await restarted();
  const current = await guest.snapshot();
  await guest.receive(oldHostOffer);
  await host.receive(guestMessages);
  await flush();
  assert.deepEqual((await guest.snapshot()).pos, current.pos);
  assert.equal((await guest.snapshot()).ply, current.ply);
  console.log("PASS: delayed requests from the previous round cannot reset the new game");

  assert.deepEqual(errors, []);
} finally {
  if (context && socket?.readyState === WebSocket.OPEN) await send("Target.disposeBrowserContext", { browserContextId: context });
  socket?.close();
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  site.closeAllConnections();
  await new Promise((resolve) => site.close(resolve));
  for (const { timer } of pending.values()) clearTimeout(timer);
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
