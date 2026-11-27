// Quoridor 9x9 browser UI: board, AI, AI-vs-AI autoplay, replay and saved games.
// Static site, no paid services: ONNX Runtime Web and PeerJS are vendored.
import { State, actionStr, A_H, A_V, N_MOVES } from "./rules.js";
import { SigmaNet, SigmaAgent, SigmaBatchAgent } from "./sigma.js?v=sigma-legal-sidestep";
import { searchGuided } from "./guided.js";
import { openSigmaGpu } from "./sigma-gpu.js";
import { ClaustrophobiaNet } from "./claustrophobia.js?v=sigma-legal-sidestep";
import { completeExternal, validExtBase, extEndpoint, EXTERNAL_PROTOCOLS, EXTERNAL_EFFORTS } from "./external-ai.js";
import { positionKey } from "./detour.js";
import { clearAIAssets, pruneAIAssets, subscribeAIAssets } from "./ai-assets.js";
import { ROOM_WORKER_URL } from "./room-config.js";
import { isRelayCode, newRelayCode, ROOM_INVITE } from "./room-crypto.js";

const $ = (id) => document.getElementById(id);
const ui = {
  boardFrame: $("boardFrame"),
  boardTools: $("boardTools"),
  themeSwitch: $("themeSwitch"),
  playerRed: $("playerRed"),
  playerBlue: $("playerBlue"),
  nameRed: $("nameRed"),
  nameBlue: $("nameBlue"),
  tagRed: $("tagRed"),
  tagBlue: $("tagBlue"),
  wallsRed: $("wallsRed"),
  wallsBlue: $("wallsBlue"),
  pipsRed: $("pipsRed"),
  pipsBlue: $("pipsBlue"),
  status: $("status"),
  hint: $("hint"),
  boardStatus: $("boardStatus"),
  aiLoading: $("aiLoading"),
  aiLoadingLabel: $("aiLoadingLabel"),
  aiLoadingDetail: $("aiLoadingDetail"),
  aiLoadingProgress: $("aiLoadingProgress"),
  resultLabel: $("resultLabel"),
  resultDialog: $("resultDialog"),
  resultEyebrow: $("resultEyebrow"),
  resultTitle: $("resultTitle"),
  resultDescription: $("resultDescription"),
  resultMatchup: $("resultMatchup"),
  resultMoves: $("resultMoves"),
  resultWalls: $("resultWalls"),
  resultWinner: $("resultWinner"),
  btnResult: $("btnResult"),
  btnResultClose: $("btnResultClose"),
  btnResultBoard: $("btnResultBoard"),
  btnResultNew: $("btnResultNew"),
  btnResultSwap: $("btnResultSwap"),
  btnResultSwapDecline: $("btnResultSwapDecline"),
  btnResultReview: $("btnResultReview"),
  btnResultUndo: $("btnResultUndo"),
  seg: $("seg"),
  bottomLabel: $("bottomLabel"),
  viewBottom: $("viewBottom"),
  roomPanel: $("roomPanel"),
  roomCode: $("roomCode"),
  roomMsg: $("roomMsg"),
  roomRematch: $("roomRematch"),
  roomHostSide: $("roomHostSide"),
  joinCode: $("joinCode"),
  btnCreate: $("btnCreate"),
  btnJoin: $("btnJoin"),
  engineRedRow: $("engineRedRow"),
  engineBlueRow: $("engineBlueRow"),
  engineCard: $("engineCard"),
  capRed: $("capRed"),
  capBlue: $("capBlue"),
  engineRed: $("engineRed"),
  engineBlue: $("engineBlue"),
  engineNote: $("engineNote"),
  extCard: document.querySelector(".ext-card"),
  btnExtToggle: $("btnExtToggle"),
  extSummary: $("extSummary"),
  extSeatRow: $("extSeatRow"),
  extSeat: $("extSeat"),
  extForm: $("extForm"),
  extBase: $("extBase"),
  extProtocol: $("extProtocol"),
  extFullEndpoint: $("extFullEndpoint"),
  extKey: $("extKey"),
  extModel: $("extModel"),
  extEffort: $("extEffort"),
  extRemember: $("extRemember"),
  extImage: $("extImage"),
  extAllowMoves: $("extAllowMoves"),
  btnExtSave: $("btnExtSave"),
  btnExtTest: $("btnExtTest"),
  btnExtForget: $("btnExtForget"),
  extNote: $("extNote"),
  chatStatus: $("chatStatus"),
  chatLog: $("chatLog"),
  chatInput: $("chatInput"),
  btnChatSend: $("btnChatSend"),
  btnChatClear: $("btnChatClear"),
  btnClearLocal: $("btnClearLocal"),
  btnClearAIFiles: $("btnClearAIFiles"),
  aiFilesFeedback: $("aiFilesFeedback"),
  btnNew: $("btnNew"),
  btnRoomSwap: $("btnRoomSwap"),
  btnRoomSwapDecline: $("btnRoomSwapDecline"),
  btnRoomResign: $("btnRoomResign"),
  roomResignDialog: $("roomResignDialog"),
  btnPlay: $("btnPlay"),
  btnUndo: $("btnUndo"),
  btnFlip: $("btnFlip"),
  btnExternalSetup: $("btnExternalSetup"),
  btnRetryAI: $("btnRetryAI"),
  speed: $("speed"),
  speedText: $("speedText"),
  replayLabel: $("replayLabel"),
  replayCard: $("replayCard"),
  replayPosition: $("replayPosition"),
  replaySpeed: $("replaySpeed"),
  continueMode: $("continueMode"),
  btnContinue: $("btnContinue"),
  continueNote: $("continueNote"),
  btnImport: $("btnImport"),
  btnExport: $("btnExport"),
  btnExportPrefix: $("btnExportPrefix"),
  importFile: $("importFile"),
  archiveNote: $("archiveNote"),
  btnPrev: $("btnPrev"),
  btnNext: $("btnNext"),
  btnAuto: $("btnAuto"),
  saveGames: $("saveGames"),
  savedList: $("savedList"),
  btnLoad: $("btnLoad"),
  btnDelete: $("btnDelete"),
  log: $("log"),
  moveCount: $("moveCount"),
};

const cvs = $("board");
const ctx = cvs.getContext("2d");
const PREF_KEY = "quoridor.prefs.v1";
const SAVE_KEY = "quoridor.savedGames.v1";
const MAX_SAVED = 80;
const DEFAULT_ENGINE = "champion:6:1200";
const GAME_FILE = "quoridor-game";
const MAX_GAME_FILE_BYTES = 64 * 1024;

const PALETTES = {
  light: { paper: "#e1e8e4", cell: "#f5f8f5", redGoal: "#f6d9d2", blueGoal: "#d8e8fa",
    red: "#c34736", blue: "#2861aa", wall: "#263f35", amber: "#92651f", ink: "#172b25",
    muted: "#455b53", ghost: "#507665", move: "#47725c" },
  dark: { paper: "#182823", cell: "#263b32", redGoal: "#52352f", blueGoal: "#2b415c",
    red: "#ef806d", blue: "#74a9f1", wall: "#e7d9b6", amber: "#efc575", ink: "#edfaf4",
    muted: "#b7c9c0", ghost: "#b4c9af", move: "#a3cdb0" },
};
let COL = PALETTES.light;
let boardTool = "auto";
// ---------------------------------------------------------------- preferences
function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; } catch (e) { return {}; }
}
const prefs = readPrefs();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let themeMode = ["auto", "dark", "light"].includes(prefs.theme) ? prefs.theme : "auto";
let mode = ["ai", "hotseat", "ai_ai"].includes(prefs.mode) ? prefs.mode : "ai";
let lastPlayMode = mode;
let humanSide = prefs.humanSide === 1 ? 1 : 0;
// The opponent keeps its engine profile when its board colour changes.
const opponentSeat = [0, 1].includes(prefs.opponentSeat) ? prefs.opponentSeat : 1 - humanSide;
let viewBottomSetting = prefs.viewBottom !== false;
let speed = clamp(Number(prefs.speed) || 0.7, 0.05, 2.5);
let replaySpeed = [0.5, 1, 1.5, 2, 3].includes(prefs.replaySpeed) ? prefs.replaySpeed : 2;
let saveEnabled = prefs.saveGames !== false;
let engineCfg = {
  0: typeof prefs.engineRed === "string" ? prefs.engineRed : DEFAULT_ENGINE,
  1: typeof prefs.engineBlue === "string" ? prefs.engineBlue : DEFAULT_ENGINE,
};
let savedGames = [];
try { savedGames = JSON.parse(localStorage.getItem(SAVE_KEY) || "[]") || []; } catch (e) { savedGames = []; }

const EXT_KEY = "quoridor.external.v2";
const EXT_SESSION_PREFIX = "quoridor.extKey.session.v2.";
const EMPTY_EXT = () => ({ baseUrl: "", protocol: "auto", fullEndpoint: false, apiKey: "", model: "", effort: "auto", remember: false, allowImage: false, allowMoveRequests: false });
let extProfiles = [EMPTY_EXT(), EMPTY_EXT()];
let extSeat = 1;
const extConversations = [[], []];
let extTurnId = 0;
try {
  const raw = JSON.parse(localStorage.getItem(EXT_KEY) || "{}");
  const list = Array.isArray(raw.profiles) ? raw.profiles : (raw.baseUrl ? [{}, raw] : []);
  for (let i = 0; i < 2; i++) {
    const p = list[i] || {};
    let sessionKey = "";
    try { sessionKey = sessionStorage.getItem(EXT_SESSION_PREFIX + i) || ""; } catch (e) {}
    extProfiles[i] = {
      baseUrl: String(p.baseUrl || ""),
      protocol: EXTERNAL_PROTOCOLS.includes(p.protocol) ? p.protocol : "auto",
      fullEndpoint: !!p.fullEndpoint,
      model: String(p.model || ""),
      effort: EXTERNAL_EFFORTS.includes(p.effort) ? p.effort : "auto",
      remember: !!p.remember,
      allowImage: !!p.allowImage,
      allowMoveRequests: !!p.allowMoveRequests,
      apiKey: p.remember ? String(p.apiKey || sessionKey) : String(sessionKey),
    };
  }
} catch (e) {}
const extMoveCaches = [new Map(), new Map()];
let extMoveRequest = null;
let chatRequest = null;
let extTestController = null;

function persistPrefs() {
  if (["ai", "hotseat", "ai_ai"].includes(mode)) lastPlayMode = mode;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      theme: themeMode, mode: lastPlayMode,
      humanSide, opponentSeat, viewBottom: viewBottomSetting, speed, replaySpeed, saveGames: saveEnabled,
      engineRed: engineCfg[0], engineBlue: engineCfg[1],
    }));
  } catch (e) {}
}
function persistSaved() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(savedGames.slice(0, MAX_SAVED))); } catch (e) {}
}

// ---------------------------------------------------------------- theme
function effectiveTheme() {
  if (themeMode === "auto") {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return themeMode;
}
function applyTheme() {
  const t = effectiveTheme();
  document.documentElement.dataset.theme = t;
  COL = PALETTES[t];
  for (const b of ui.themeSwitch.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.theme === themeMode);
    b.setAttribute("aria-pressed", String(b.dataset.theme === themeMode));
  }
  draw();
}
function setTheme(next) {
  themeMode = ["auto", "dark", "light"].includes(next) ? next : "auto";
  applyTheme();
  persistPrefs();
}
if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", () => { if (themeMode === "auto") applyTheme(); });
  else if (mq.addListener) mq.addListener(() => { if (themeMode === "auto") applyTheme(); });
}

// ---------------------------------------------------------------- engines
const ENGINE_OPTIONS = [
  ["champion:10:3000", "Claustrophobia + Alpha-beta · deep (3 s)"],
  ["champion:6:1200", "Claustrophobia + Alpha-beta · standard (1.2 s)"],
  ["guided:6:1200", "Guided Alpha-beta · experimental (1.2 s)"],
  ["sigma:0", "Sigma · policy only"],
  ["sigma:64", "Sigma · quick search"],
  ["sigma:256", "Sigma · standard search"],
  ["sigma:512", "Sigma · extended search (up to 2.4 s)"],
  ["sigma:1024", "Sigma · 1024 target / 3.2 s"],
  ["sigma:2048", "Sigma · 2048 target / 4 s"],
  ["ab:4:350", "Alpha-beta · quick (0.35 s)"],
  ["ab:6:1200", "Alpha-beta · standard (1.2 s)"],
  ["ab:8:2200", "Alpha-beta · deep (2.2 s)"],
  ["ab:10:4000", "Alpha-beta · maximum (4 s)"],
  ["ext:default", "External AI · configured endpoint"],
];
function fillEngineSelect(sel, value) {
  sel.innerHTML = "";
  for (const [v, label] of ENGINE_OPTIONS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  if (!ENGINE_OPTIONS.some(([v]) => v === value)) value = DEFAULT_ENGINE;
  sel.value = value;
  return value;
}
function parseEngine(v) {
  const [kind, a, b] = String(v).split(":");
  if (kind === "sigma") return { kind, sims: Number(a) || 0 };
  if (kind === "ext") return { kind: "ext" };
  return { kind: kind === "guided" || kind === "champion" ? kind : "ab", depth: Number(a) || 6, ms: Number(b) || 1200 };
}
function engineSeat(side) {
  return mode === "ai" && side !== humanSide ? opponentSeat : side;
}
function engineName(side) {
  const cfg = parseEngine(engineCfg[engineSeat(side)]);
  if (cfg.kind === "sigma") return cfg.sims ? `Sigma ${cfg.sims}` : "Sigma";
  if (cfg.kind === "ext") {
    const model = extProfile(engineSeat(side)).model;
    return model ? `External ${model}` : "External AI";
  }
  return `${searchName(cfg.kind)} ${cfg.ms / 1000}s`;
}
function engineShort(side) {
  const cfg = parseEngine(engineCfg[engineSeat(side)]);
  if (cfg.kind === "sigma") return `Sigma ${cfg.sims}`;
  if (cfg.kind === "ext") return "External AI";
  return `${searchName(cfg.kind)} ${cfg.ms / 1000}s`;
}

function searchName(kind) {
  if (kind === "champion") return "Claustrophobia + Alpha-beta";
  return kind === "guided" ? "Guided Alpha-beta" : "Alpha-beta";
}

// ---------------------------------------------------------------- app state
let state = State.new();
let history = [state];
let moves = [];                    // [{ n, side, a, text }]
let lastAction = null;
let busy = false;
let aiRetryAvailable = false;
let aiEpoch = 0;
let aiTimer = null;
let lastInfo = "";
let lastAiMetrics = null;
let lastExtSay = "";
let hover = null;
let wallDrag = null;
let suppressWallClick = null;
let geo = null;
let viewFlip = false;
let running = false;
let savedLines = new Set();
let selectedSavedId = null;
let presentedResult = null;
let finishedPlayers = null;

let replayStates = null;
let replayMoves = [];
let replayRecord = null;
let replayIdx = 0;
let replayPlaying = false;
let replayTimer = null;

let sigmaNet = null;
let sigmaPromise = null;
let championPromise = null;
let championReady = false;
let prewarmTimer = null;
let sigmaQueue = Promise.resolve();
let sigmaBatch = false;
let sigmaGpuUnavailable = false;
let sigmaAgents = { 0: null, 1: null };
let alphaWorker = null;
let cancelAlphaSearch = null;

let peer = null, conn = null, roomCode = null, roomRole = null, roomReady = false;
let mySide = 0;
let roomRematchPending = false;
let roomRequest = null, roomNotice = "", roomRound = 0, roomSeatSupport = false;
let resignedSide = null, resignPending = false, roomRematchId = null;
const ROOM_SEATS_VERSION = 1;

function playerName(side) {
  if (state?.terminal && mode !== "replay" && finishedPlayers) return finishedPlayers[side].name;
  if (mode === "replay" && replayRecord) return side === 0 ? (replayRecord.p0 || "Red") : (replayRecord.p1 || "Blue");
  if (mode === "room") return side === mySide ? "You" : "Opponent";
  if (mode === "hotseat") return side === 0 ? "Player 1" : "Player 2";
  if (mode === "ai") return side === humanSide ? "You" : engineName(side);
  return engineName(side);
}
function playerTag(side) {
  if (state?.terminal && mode !== "replay" && finishedPlayers) return finishedPlayers[side].tag;
  const base = side === 0 ? "bottom · reach the top" : "top · reach the bottom";
  if (mode === "ai" && side !== humanSide) return `${base} · ${engineShort(side)}`;
  if (mode === "ai_ai") return `${base} · ${engineShort(side)}`;
  return base;
}

// ---------------------------------------------------------------- geometry / drawing
function layout() {
  const frame = ui.boardFrame.getBoundingClientRect();
  const touchLayout = matchMedia("(pointer: coarse)").matches || innerWidth <= 760;
  const availableHeight = touchLayout ? 660 : Math.max(300, innerHeight - 235);
  const side = Math.min(frame.width, availableHeight, 660);
  const cell = Math.max(1, Math.floor(side / 10.48));
  const margin = Math.floor(cell * .74);
  const size = cell * 9 + margin * 2;
  const dpr = window.devicePixelRatio || 1;
  const backingWidth = Math.max(1, Math.floor(size * dpr));
  const backingHeight = Math.max(1, Math.floor(size * dpr));
  const geometryChanged = !geo || geo.cell !== cell || geo.margin !== margin || geo.size !== size;
  if (cvs.style.width !== size + "px") cvs.style.width = size + "px";
  if (cvs.style.height !== size + "px") cvs.style.height = size + "px";
  let backingChanged = false;
  if (cvs.width !== backingWidth) { cvs.width = backingWidth; backingChanged = true; }
  if (cvs.height !== backingHeight) { cvs.height = backingHeight; backingChanged = true; }
  if (backingChanged) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  geo = { cell, margin, size };
  if (geometryChanged || backingChanged) draw();
}
const cx = (c) => geo.margin + (c + 0.5) * geo.cell;
const cy = (r) => geo.margin + (r + 0.5) * geo.cell;
const viewCell = (r, c) => (viewFlip ? [8 - r, 8 - c] : [r, c]);
const viewWall = (r, c) => (viewFlip ? [7 - r, 7 - c] : [r, c]);

function draw() {
  if (!geo) return;
  const { cell, margin, size } = geo;
  ctx.clearRect(0, 0, size, size);
  roundRect(0, 0, size, size, 18, COL.paper);
  const redGoal = viewFlip ? 8 : 0;
  const blueGoal = viewFlip ? 0 : 8;
  const gap = Math.max(2, Math.round(cell * .085));
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const color = r === redGoal ? COL.redGoal : r === blueGoal ? COL.blueGoal : COL.cell;
    roundRect(margin + c * cell + gap / 2, margin + r * cell + gap / 2,
      cell - gap, cell - gap, cell * .13, color);
  }

  ctx.fillStyle = COL.muted;
  ctx.font = `600 ${Math.max(10, Math.round(cell * .24))}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let c = 0; c < 9; c++) {
    const ch = String.fromCharCode(97 + (viewFlip ? 8 - c : c));
    ctx.fillText(ch, cx(c), margin * .52);
  }
  for (let r = 0; r < 9; r++) {
    ctx.fillText(String(viewFlip ? 9 - r : r + 1), margin * .52, cy(r));
  }

  if (canPlay() && !busy && boardTool === "auto") {
    for (const action of state.moves()) {
      const [r, c] = viewCell(...divmod(action));
      const radius = Math.max(2.5, cell * .085);
      ctx.beginPath(); ctx.arc(cx(c), cy(r), radius, 0, 2 * Math.PI);
      ctx.fillStyle = COL.move; ctx.fill();
    }
  }
  if (lastAction !== null) drawLast(lastAction);

  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (state.hw[r * 8 + c]) { const d = viewWall(r, c); drawWall("H", d[0], d[1]); }
    if (state.vw[r * 8 + c]) { const d = viewWall(r, c); drawWall("V", d[0], d[1]); }
  }

  if (hover && canPlay() && !busy) {
    const ok = legalHover();
    ctx.globalAlpha = ok ? 1 : wallDrag?.active ? .85 : .3;
    if (hover.kind === "cell") {
      const x = margin + hover.c * cell, y = margin + hover.r * cell;
      roundRect(x + 2.5, y + 2.5, cell - 5, cell - 5, 6, null);
      ctx.strokeStyle = COL.move;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      drawWall(hover.kind, hover.r, hover.c, !ok && wallDrag?.active ? COL.red : COL.ghost);
    }
    ctx.globalAlpha = 1;
  }

  const r = viewCell(...divmod(state.pos[0]));
  const b = viewCell(...divmod(state.pos[1]));
  drawPawn(r[0], r[1], COL.red);
  drawPawn(b[0], b[1], COL.blue);
}

function divmod(pos) { return [Math.floor(pos / 9), pos % 9]; }

function drawPawn(r, c, color) {
  const x = cx(c), y = cy(r);
  const rad = geo.cell * .33;
  ctx.save();
  ctx.shadowColor = "rgba(60,45,25,.28)";
  ctx.shadowBlur = rad * .5;
  ctx.shadowOffsetY = rad * .16;
  const grad = ctx.createRadialGradient(x - rad * .38, y - rad * .42, rad * .15, x, y, rad);
  grad.addColorStop(0, lighten(color, .30));
  grad.addColorStop(.62, color);
  grad.addColorStop(1, darken(color, .16));
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,253,247,.9)";
  ctx.lineWidth = Math.max(1.6, rad * .11);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - rad * .32, y - rad * .36, rad * .22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.20)";
  ctx.fill();
}

function drawWall(kind, r, c, color) {
  const { cell, margin } = geo;
  const t = Math.max(7, Math.round(cell * .15));
  const gap = Math.max(2, Math.round(t * .35));
  const fill = color || COL.wall;
  ctx.save();
  if (!color) {
    ctx.shadowColor = "rgba(55,40,22,.30)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
  }
  if (kind === "H") {
    const x = margin + c * cell + gap;
    const y = margin + (r + 1) * cell - t / 2;
    roundRect(x, y, cell * 2 - gap * 2, t, t * .35, fill);
    if (!color) roundRect(x + 1, y + 1, cell * 2 - gap * 2 - 2, t * .3, t * .15, "rgba(255,255,255,.10)");
  } else {
    const y = margin + r * cell + gap;
    const x = margin + (c + 1) * cell - t / 2;
    roundRect(x, y, t, cell * 2 - gap * 2, t * .35, fill);
    if (!color) roundRect(x + 1, y + 1, t * .25, cell * 2 - gap * 2 - 2, t * .1, "rgba(255,255,255,.10)");
  }
  ctx.restore();
}

function drawLast(a) {
  const { cell, margin } = geo;
  ctx.save();
  ctx.strokeStyle = COL.amber;
  ctx.shadowColor = "rgba(195,146,60,.55)";
  ctx.shadowBlur = 8;
  if (a < N_MOVES) {
    const [r, c] = viewCell(...divmod(a));
    ctx.lineWidth = Math.max(2.5, cell * .06);
    roundRect(margin + c * cell + 2.5, margin + r * cell + 2.5, cell - 5, cell - 5, 6, null);
    ctx.stroke();
  } else {
    const t = Math.max(7, Math.round(cell * .15));
    const kind = a < A_V ? "H" : "V";
    const i = kind === "H" ? a - A_H : a - A_V;
    const rr = Math.floor(i / 8), cc = i % 8;
    const [r, c] = viewWall(rr, cc);
    ctx.lineWidth = 2;
    if (kind === "H") {
      roundRect(margin + c * cell - 3, margin + (r + 1) * cell - t / 2 - 3.5, cell * 2 + 6, t + 7, (t + 7) * .35, null);
    } else {
      roundRect(margin + (c + 1) * cell - t / 2 - 3.5, margin + r * cell - 3, t + 7, cell * 2 + 6, (t + 7) * .35, null);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * (1 + k) + 255 * k * .2));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * (1 + k) + 255 * k * .2));
  const b = Math.min(255, Math.round((n & 255) * (1 + k) + 255 * k * .2));
  return `rgb(${r},${g},${b})`;
}
function darken(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.round(((n >> 16) & 255) * (1 - k))},${Math.round(((n >> 8) & 255) * (1 - k))},${Math.round((n & 255) * (1 - k))})`;
}

// ---------------------------------------------------------------- picking
function pick(evt, tool = boardTool) {
  if (!geo) return null;
  const rect = cvs.getBoundingClientRect();
  const x = evt.clientX - rect.left, y = evt.clientY - rect.top;
  const gx = (x - geo.margin) / geo.cell, gy = (y - geo.margin) / geo.cell;
  if (gx < -.45 || gy < -.45 || gx > 9.45 || gy > 9.45) return null;
  const dx = Math.abs(gx - Math.round(gx));
  const dy = Math.abs(gy - Math.round(gy));
  if (tool !== "auto") {
    if (gx < 0 || gy < 0 || gx > 9 || gy > 9) return null;
    const anchor = (n) => clamp(Math.round(n) - 1, 0, 7);
    return { kind: tool, r: anchor(gy), c: anchor(gx) };
  }
  const TH = .13;
  const kr = Math.round(gy), kc = Math.round(gx);
  const canH = dy < TH && kr >= 1 && kr <= 8;
  const canV = dx < TH && kc >= 1 && kc <= 8;
  if (canH && (!canV || dy <= dx)) return { kind: "H", r: kr - 1, c: clampAnchor(gx) };
  if (canV) return { kind: "V", r: clampAnchor(gy), c: kc - 1 };
  const r = Math.floor(gy), c = Math.floor(gx);
  if (r < 0 || r > 8 || c < 0 || c > 8) return null;
  return { kind: "cell", r, c };
}
function clampAnchor(v) {
  const raw = Math.floor(v);
  return Math.min(7, Math.max(0, v - raw < .5 ? raw - 1 : raw));
}
function actionOf(h) {
  let e = h;
  if (viewFlip) e = h.kind === "cell"
    ? { kind: "cell", r: 8 - h.r, c: 8 - h.c }
    : { kind: h.kind, r: 7 - h.r, c: 7 - h.c };
  if (!e) return null;
  if (e.kind === "cell") return e.r * 9 + e.c;
  if (e.kind === "H") return A_H + e.r * 8 + e.c;
  return A_V + e.r * 8 + e.c;
}
let actionState = null;
let actions = [];
function actionsFor(position) {
  if (actionState !== position) {
    actions = position.legal();
    actionState = position;
  }
  return actions;
}
function legalHover() {
  const a = actionOf(hover);
  return a !== null && actionsFor(state).includes(a);
}

// ---------------------------------------------------------------- UI update
function status(text, hint) {
  ui.status.textContent = text;
  if (hint !== undefined) ui.hint.textContent = hint;
}
function closeResult() {
  if (ui.resultDialog.open) ui.resultDialog.close();
}
function updateResult() {
  const finished = state.terminal;
  const liveResult = finished && mode !== "replay";
  if (finished && ui.roomResignDialog?.open) ui.roomResignDialog.close();
  ui.boardStatus.classList.toggle("complete", finished);
  ui.resultLabel.hidden = !finished;
  ui.btnResult.hidden = !liveResult;
  if (!liveResult) {
    closeResult();
    presentedResult = null;
    finishedPlayers = null;
  }
  if (!finished) return;

  const colour = state.winner === 0 ? "Red" : "Blue";
  const localSide = mode === "ai" ? humanSide : mode === "room" ? mySide : null;
  const outcome = localSide === null ? "neutral" : state.winner === localSide ? "victory" : "defeat";
  const title = localSide === null ? `${colour} wins!` : outcome === "victory" ? "You won!" : "You lost this round";
  const label = outcome === "victory" ? "Victory" : outcome === "defeat" ? "Defeat" : "Game complete";
  const description = mode === "room" && resignedSide !== null
    ? `${resignedSide === 0 ? "Red" : "Blue"} resigned. ${colour} wins.`
    : `${colour} reached the opposite edge first.`;
  for (const element of [ui.boardStatus, ui.resultDialog]) {
    element.dataset.winner = colour.toLowerCase();
    element.dataset.outcome = outcome;
  }
  ui.resultLabel.textContent = label;
  ui.resultEyebrow.textContent = label;
  ui.resultTitle.textContent = title;
  const rematch = roomRematchMessage();
  const details = rematch ? `${description} ${rematch}` : description;
  if (ui.resultDescription.textContent !== details) ui.resultDescription.textContent = details;
  ui.resultMatchup.textContent = `${playerName(0)} vs ${playerName(1)}`;
  ui.resultMoves.textContent = state.ply;
  ui.resultWalls.textContent = 20 - state.walls[0] - state.walls[1];
  ui.resultWinner.textContent = colour;
  ui.btnResultReview.hidden = mode === "room";
  ui.btnResultUndo.hidden = undoIndex() < 0;
  if (liveResult) status(title, `${description} ${state.ply} moves played.`);
}
function openResult() {
  if (!state.terminal || mode === "replay" || ui.resultDialog.open) return;
  ui.resultDialog.showModal();
}
function presentResult() {
  // A room resync creates fresh state objects for the same finished game.
  const key = `${mode}:${roomRound}:${state.winner}:${resignedSide}:${moves.map((move) => move.a).join(",")}`;
  if (presentedResult === key || mode === "replay") return;
  presentedResult = key;
  openResult();
}
function reviewFinishedGame() {
  if (!state.terminal || mode === "room" || mode === "replay") return;
  const record = { moves: moves.map((move) => move.a), p0: playerName(0), p1: playerName(1) };
  closeResult();
  // Works even when automatic saving is off or browser storage is unavailable.
  loadRecord(record, true);
  ui.btnPrev.focus({ preventScroll: true });
}
function pips(el, n) {
  if (el.childElementCount !== 10) {
    el.innerHTML = "";
    for (let i = 0; i < 10; i++) {
      const d = document.createElement("div");
      d.className = "pip";
      el.appendChild(d);
    }
  }
  [...el.children].forEach((d, i) => { d.className = "pip" + (i < n ? " on" : ""); });
}
function updatePlayers() {
  ui.nameRed.textContent = playerName(0);
  ui.nameBlue.textContent = playerName(1);
  ui.tagRed.textContent = playerTag(0);
  ui.tagBlue.textContent = playerTag(1);
  ui.wallsRed.textContent = state.walls[0];
  ui.wallsBlue.textContent = state.walls[1];
  pips(ui.pipsRed, state.walls[0]);
  pips(ui.pipsBlue, state.walls[1]);
  ui.playerRed.classList.toggle("active", !state.terminal && state.turn === 0);
  ui.playerBlue.classList.toggle("active", !state.terminal && state.turn === 1);
  ui.playerRed.classList.toggle("winner", state.winner === 0);
  ui.playerBlue.classList.toggle("winner", state.winner === 1);
  ui.playerRed.dataset.winner = "red";
  ui.playerBlue.dataset.winner = "blue";
  ui.nameRed.title = playerName(0) + (state.winner === 0 ? " · Winner" : "");
  ui.nameBlue.title = playerName(1) + (state.winner === 1 ? " · Winner" : "");
}
function updateModeButtons() {
  for (const b of ui.seg.querySelectorAll("button")) {
    const active = b.dataset.mode === mode;
    b.classList.toggle("on", active);
    b.setAttribute("aria-pressed", String(active));
  }
  ui.roomPanel.classList.toggle("show", mode === "room");
}
function updateEngineRows() {
  const showRed = mode === "ai_ai" || (mode === "ai" && humanSide === 1);
  const showBlue = mode === "ai_ai" || (mode === "ai" && humanSide === 0);
  if (ui.engineCard) ui.engineCard.classList.toggle("hide", !(mode === "ai" || mode === "ai_ai"));
  ui.engineRedRow.classList.toggle("hide", !showRed);
  ui.engineBlueRow.classList.toggle("hide", !showBlue);
  ui.capRed.textContent = mode === "ai" ? "OPPONENT ENGINE (RED)" : "RED ENGINE";
  ui.capBlue.textContent = mode === "ai" ? "OPPONENT ENGINE (BLUE)" : "BLUE ENGINE";
  ui.engineRed.value = engineCfg[engineSeat(0)];
  ui.engineBlue.value = engineCfg[engineSeat(1)];
  if (mode === "replay") ui.engineNote.textContent = "Review the moves or continue from this position.";
  else if (mode === "room") ui.engineNote.textContent = "Room games are human vs human.";
  else if (mode === "hotseat") ui.engineNote.textContent = "Two humans on one screen.";
  else if (mode === "ai_ai") ui.engineNote.textContent = "Each side can use a different engine.";
  else if (parseEngine(engineCfg[opponentSeat]).kind === "ext") ui.engineNote.textContent = extConfigured(opponentSeat)
    ? extProfile(opponentSeat).allowMoveRequests
      ? "External AI ready."
      : "Enable automatic move requests in External AI settings to play."
    : "Set up your endpoint in External AI settings.";
  else if (parseEngine(engineCfg[opponentSeat]).kind === "sigma") ui.engineNote.textContent = "The first move loads the model. Each tier is a simulation target with a time limit. Actual counts appear after each move.";
  else if (parseEngine(engineCfg[opponentSeat]).kind === "guided") ui.engineNote.textContent = "Sigma suggests which moves Detour should search first. The model loads on the first move.";
  else if (parseEngine(engineCfg[opponentSeat]).kind === "champion") ui.engineNote.textContent = "Claustrophobia guides the search. The browser loads the 28.5 MB model on the first move.";
  else ui.engineNote.textContent = "Detour search runs on this device without a model download.";
}
function externalMoveRunning() {
  return busy && ["ai", "ai_ai"].includes(mode) && parseEngine(engineCfg[engineSeat(state.turn)]).kind === "ext";
}
function updateButtons() {
  ui.boardTools.hidden = mode === "replay";
  ui.btnExternalSetup.hidden = !externalTurnBlock();
  const canCancelMove = externalMoveRunning();
  ui.btnRetryAI.textContent = canCancelMove ? "Cancel AI move" : "Retry AI move";
  ui.btnRetryAI.hidden = !canCancelMove && (!aiRetryAvailable || state.terminal || (mode === "ai" && state.turn === humanSide));
  ui.btnPlay.hidden = mode !== "ai_ai" || state.terminal;
  ui.btnPlay.textContent = mode === "ai_ai" && running ? "Pause" : "Play";
  ui.btnUndo.hidden = mode !== "ai" && mode !== "hotseat";
  ui.btnUndo.disabled = undoIndex() < 0;
  ui.btnUndo.title = mode === "ai" ? "Return to your previous turn" : "Take back one move";
  ui.btnFlip.hidden = mode !== "ai" && mode !== "ai_ai";
  ui.btnFlip.disabled = mode === "ai" && state.terminal;
  ui.btnFlip.title = mode === "ai" ? (state.terminal ? "Undo or start a new game to switch colours" : "Switch colours from the current position") : "Swap engines and start a new game";
  updateRestartButtons();
  const total = replayStates ? replayStates.length - 1 : 0;
  ui.replayCard.hidden = !replayStates;
  ui.btnPrev.disabled = replayIdx === 0;
  ui.btnNext.disabled = replayIdx === total;
  ui.btnAuto.disabled = !replayPlaying && replayIdx === total;
  ui.replayPosition.max = total;
  ui.replayPosition.value = replayIdx;
  ui.replayPosition.disabled = total === 0;
  ui.btnContinue.disabled = !replayStates || state.terminal;
  ui.continueNote.textContent = state.terminal ? "Game over here. Go back a move to continue." : "";
  ui.btnImport.disabled = mode === "room";
  ui.btnExport.disabled = mode === "room" || (mode === "replay" && !replayStates);
  ui.btnExport.textContent = mode === "replay" ? "Export full game" : "Export position";
  ui.btnExport.title = replayStates ? `Download all ${total} recorded moves` : "Download the moves leading to the current position";
  ui.btnExportPrefix.hidden = !replayStates || replayIdx === total;
  ui.btnExportPrefix.textContent = `Export up to move ${replayIdx}`;
  ui.btnAuto.textContent = replayPlaying ? "Stop" : "Auto";
  ui.btnLoad.disabled = !selectedSavedId || mode === "room";
  ui.btnDelete.disabled = !savedGames.length;
  ui.replayLabel.textContent = replayStates ? `move ${replayIdx} / ${total}` : "move 0 / 0";
}
function renderLog() {
  const red = [], blue = [];
  for (const m of moves) (m.side === 0 ? red : blue).push(m);
  ui.log.innerHTML = `<div class="h">RED</div><div class="h">BLUE</div>` +
    Array.from({ length: Math.max(red.length, blue.length) }, (_, i) => {
      const a = red[i], b = blue[i];
      return `<div>${a ? `<span class="n">${a.n}</span><span class="r">${a.text}</span>` : ""}</div>` +
             `<div>${b ? `<span class="n">${b.n}</span><span class="b">${b.text}</span>` : ""}</div>`;
    }).join("");
  ui.log.scrollTop = ui.log.scrollHeight;
  ui.moveCount.textContent = `${moves.length} move${moves.length === 1 ? "" : "s"}`;
}
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "").slice(0, 16);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
function renderSaved() {
  ui.savedList.innerHTML = "";
  if (!savedGames.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No games saved yet.";
    ui.savedList.appendChild(e);
    selectedSavedId = null;
    return;
  }
  for (const rec of savedGames) {
    const b = document.createElement("button");
    b.className = "saved-row" + (rec.id === selectedSavedId ? " selected" : "");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = formatDate(rec.date);
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `${rec.winner === 0 ? "red" : rec.winner === 1 ? "blue" : "unfinished"} · ${rec.plies} plies`;
    b.append(when, who);
    b.title = `${rec.p0 || "Red"} vs ${rec.p1 || "Blue"}`;
    b.addEventListener("click", () => { selectedSavedId = rec.id; renderSaved(); updateButtons(); });
    ui.savedList.appendChild(b);
  }
}
function render() {
  cancelWallDrag();
  $("speedCard").hidden = mode !== "ai_ai";
  updatePlayers();
  updateModeButtons();
  updateEngineRows();
  updateExtVisibility();
  updateButtons();
  updateResult();
  updateAILoading();
  renderLog();
  draw();
}

// ---------------------------------------------------------------- sigma
let aiAssetsProgress = [], loadingPaint = null;
function updateAILoading() {
  const engines = mode === "ai" ? [parseEngine(engineCfg[opponentSeat]).kind]
    : mode === "ai_ai" ? Object.values(engineCfg).map((config) => parseEngine(config).kind) : [];
  const loading = engines.includes("champion") && championPromise && !championReady
    || engines.some((kind) => kind === "sigma" || kind === "guided") && sigmaPromise;
  ui.aiLoading.hidden = !loading;
  if (!loading) return;
  const download = aiAssetsProgress.find((asset) => asset.phase === "download");
  let label = "Initializing AI on this device", detail = "First use may take longer";
  ui.aiLoadingProgress.removeAttribute("value");
  if (download) {
    label = download.url.includes(".wasm") ? "Downloading AI runtime" : "Downloading AI model";
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    detail = download.total ? `${mb(download.loaded)} / ${mb(download.total)} MB` : `${mb(download.loaded)} MB received`;
    if (download.total && download.loaded <= download.total) {
      ui.aiLoadingProgress.max = download.total;
      ui.aiLoadingProgress.value = download.loaded;
    }
  } else if (aiAssetsProgress.some((asset) => asset.phase === "verify")) label = "Checking AI files";
  else if (aiAssetsProgress.length) label = "Reading saved AI files";
  ui.aiLoadingLabel.textContent = label;
  ui.aiLoadingDetail.textContent = detail;
}
subscribeAIAssets((assets) => {
  aiAssetsProgress = assets;
  if (loadingPaint === null) loadingPaint = requestAnimationFrame(() => { loadingPaint = null; updateAILoading(); });
});
function loadRuntime() {
  if (globalThis.ort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/ort/ort.min.js", import.meta.url);
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error("Could not load the local model runtime")); };
    document.head.append(script);
  });
}
function ensureSigma() {
  if (sigmaNet) return Promise.resolve(sigmaNet);
  if (sigmaPromise) return sigmaPromise;
  sigmaPromise = (async () => {
    if (navigator.gpu && !sigmaGpuUnavailable) {
      let gpu;
      try {
        gpu = await openSigmaGpu();
        if (gpu) {
          const net = new SigmaNet(gpu, gpu.infer);
          const opening = State.new();
          const moved = opening.doAction(67);
          const single = await net.raw(moved), batch = await net.rawBatch([opening, moved]);
          if (!(Math.abs(single[1] - batch[1].value) < .01) ||
              single[0].some((value, i) => !(Math.abs(value - batch[1].logits[i]) < .01))) {
            throw new Error("WebGPU batch output differed from single-position inference");
          }
          sigmaBatch = true;
          return sigmaNet = net;
        }
      } catch (err) {
        gpu?.release();
        console.warn("WebGPU path failed, falling back to wasm", err);
      }
      sigmaGpuUnavailable = true;
    }
    await loadRuntime();
    sigmaBatch = false;
    return sigmaNet = await SigmaNet.load("./models/sigma_9x9.onnx");
  })().finally(() => { sigmaPromise = null; updateAILoading(); });
  updateAILoading();
  return sigmaPromise;
}
function ensureChampion() {
  championPromise ??= (async () => {
    await loadRuntime();
    const net = await ClaustrophobiaNet.load("./models/claustrophobia_v1_3_1.onnx");
    championReady = true;
    return net;
  })().catch((error) => {
    championPromise = null;
    throw error;
  }).finally(updateAILoading);
  updateAILoading();
  return championPromise;
}
function prewarmEngine() {
  clearTimeout(prewarmTimer);
  if (mode !== "ai" || state.terminal || state.turn !== humanSide) return;
  const kind = parseEngine(engineCfg[opponentSeat]).kind;
  if (!["champion", "guided", "sigma"].includes(kind)) return;
  prewarmTimer = setTimeout(() => {
    if (mode !== "ai" || parseEngine(engineCfg[opponentSeat]).kind !== kind) return;
    void (kind === "champion" ? ensureChampion() : ensureSigma()).catch(() => {});
  }, 200);
}
function sigmaAgentFor(side, cfg) {
  const sims = cfg.sims;
  const key = `${sigmaBatch ? "b" : "s"}:${sims}`;
  let ag = sigmaAgents[side];
  if (!ag || ag.__key !== key) {
    ag = sigmaBatch
      ? new SigmaBatchAgent(sigmaNet, { sims, batch: 8 })
      : new SigmaAgent(sigmaNet, { sims });
    ag.__key = key;
    sigmaAgents[side] = ag;
  }
  return ag;
}
function searchAlphaBeta(position, { depth, ms, policy, policyWeight }) {
  return new Promise((resolve, reject) => {
    const worker = alphaWorker ??= new Worker(new URL("./alphabeta-worker.js", import.meta.url), { type: "module" });
    const fail = (error) => {
      worker.terminate();
      alphaWorker = null;
      cancelAlphaSearch = null;
      reject(error);
    };
    worker.onmessage = ({ data }) => {
      cancelAlphaSearch = null;
      if (data.error) fail(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => fail(new Error(event.message || "Alpha-beta could not start"));
    cancelAlphaSearch = () => fail(new DOMException("Search cancelled", "AbortError"));
    const { pos, walls, hw, vw, turn, ply, winner } = position;
    const seen = new Map();
    for (const previous of history) {
      const key = positionKey(previous);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    worker.postMessage({ position: { pos, walls, hw, vw, turn, ply, winner }, depth, ms, policy, policyWeight, seen: [...seen] });
  });
}
function resetAgents() {
  for (const ag of Object.values(sigmaAgents)) if (ag) ag.reset();
}

// ---------------------------------------------------------------- external AI
let extFormOpen = !(extProfiles[extSeat].baseUrl && extProfiles[extSeat].model);
let extFieldsSeat = null;
function extProfile(seat = extSeat) { return extProfiles[seat]; }
function extConfigured(seat = extSeat) { const p = extProfile(seat); return !!(p.baseUrl && p.model); }
function externalTurnBlock() {
  if (!state || state.terminal || !["ai", "ai_ai"].includes(mode)) return null;
  if (mode === "ai" && state.turn === humanSide) return null;
  const seat = engineSeat(state.turn);
  if (parseEngine(engineCfg[seat]).kind !== "ext") return null;
  const configured = extConfigured(seat);
  return configured && extProfile(seat).allowMoveRequests ? null : { seat, configured };
}
function showExternalSetup(block = externalTurnBlock()) {
  if (!block) return;
  if (extSeat !== block.seat) setExtSeat(block.seat);
  extFormOpen = true;
  renderExt();
  ui.extCard.scrollIntoView({ behavior: "smooth", block: "center" });
  (block.configured ? ui.extAllowMoves : ui.extBase).focus({ preventScroll: true });
}
function pauseExternalTurn(block) {
  busy = false;
  if (mode === "ai_ai") running = false;
  if (extSeat !== block.seat) setExtSeat(block.seat);
  extFormOpen = true;
  render();
  const resume = mode === "ai_ai" ? " Then press Play." : "";
  status(block.configured ? "External AI needs permission" : "Set up external AI",
    (block.configured
      ? "Enable automatic move requests, then Save & apply."
      : "Enter the endpoint and model, allow move requests, then Save & apply.") + resume);
}
function persistExt() {
  const payload = {
    profiles: extProfiles.map((p, i) => {
      const out = { baseUrl: p.baseUrl, protocol: p.protocol, fullEndpoint: !!p.fullEndpoint,
        model: p.model, effort: p.effort, remember: !!p.remember, allowImage: !!p.allowImage,
        allowMoveRequests: !!p.allowMoveRequests };
      if (p.remember) out.apiKey = p.apiKey;
      try { sessionStorage.setItem(EXT_SESSION_PREFIX + i, p.apiKey); } catch (e) {}
      return out;
    }),
  };
  try { localStorage.setItem(EXT_KEY, JSON.stringify(payload)); } catch (e) {}
}
// Also removes legacy unremembered keys from persistent storage on startup.
persistExt();

function cancelChat(seat = null) {
  if (!chatRequest || (seat !== null && chatRequest.seat !== seat)) return;
  chatRequest.controller.abort();
  chatRequest = null;
}
function resetExternalConversation(seat) {
  cancelChat(seat);
  extConversations[seat] = [];
  extMoveCaches[seat].clear();
}
function resetExternalConversations() {
  extTestController?.abort();
  for (const seat of [0, 1]) resetExternalConversation(seat);
}
function clearAiChat() {
  if (extMoveRequest?.seat === extSeat) return;
  resetExternalConversation(extSeat);
  renderExt();
}
function forgetExternalKey() {
  cancelAi();
  resetExternalConversation(extSeat);
  extTestController?.abort();
  extProfile().apiKey = "";
  extProfile().remember = false;
  extProfile().allowMoveRequests = false;
  ui.extKey.value = "";
  ui.extRemember.checked = false;
  ui.extAllowMoves.checked = false;
  persistExt();
  try { sessionStorage.removeItem(EXT_SESSION_PREFIX + extSeat); } catch {}
  ui.extNote.textContent = "API key removed from this tab and this device. This does not revoke it at the provider.";
  render();
  const block = externalTurnBlock();
  if (block) pauseExternalTurn(block);
}
async function clearLocalData() {
  if (!window.confirm("Delete this app's saved games, preferences, API settings and AI downloads on this device? This cannot delete data already sent to third parties.")) return;
  cancelAi();
  cancelChat();
  extTestController?.abort();
  resetPeer();
  for (const key of [PREF_KEY, SAVE_KEY, EXT_KEY]) {
    try { localStorage.removeItem(key); } catch {}
  }
  for (let seat = 0; seat < 2; seat++) {
    try { sessionStorage.removeItem(EXT_SESSION_PREFIX + seat); } catch {}
  }
  await clearAIAssets();
  location.reload();
}
function externalColour(seat = extSeat) {
  return (mode === "ai" ? 1 - humanSide : seat) === 0 ? "Red" : "Blue";
}
function renderExt() {
  const p = extProfile();
  const configured = extConfigured();
  ui.extForm.classList.toggle("hide", !extFormOpen);
  if (extFieldsSeat !== extSeat) {
    ui.extBase.value = p.baseUrl;
    ui.extProtocol.value = p.protocol;
    ui.extFullEndpoint.checked = p.fullEndpoint;
    ui.extKey.value = p.apiKey;
    ui.extModel.value = p.model;
    ui.extEffort.value = p.effort;
    ui.extRemember.checked = p.remember;
    ui.extImage.checked = p.allowImage;
    ui.extAllowMoves.checked = p.allowMoveRequests;
    extFieldsSeat = extSeat;
  }
  ui.extSeat.value = String(extSeat);
  if (configured) {
    let host = p.baseUrl;
    try { host = new URL(p.baseUrl).host; } catch (e) {}
    ui.extSummary.textContent = `${externalColour().toUpperCase()} · ${p.model} · ${host}`;
  } else {
    ui.extSummary.textContent = `${externalColour().toUpperCase()} · not configured`;
  }
  ui.btnExtToggle.textContent = extFormOpen ? "close" : "settings";
  const chatting = chatRequest?.seat === extSeat;
  const moving = extMoveRequest?.seat === extSeat;
  ui.chatStatus.textContent = chatting ? "thinking" : moving ? "playing" : configured ? "ready" : "offline";
  ui.btnChatSend.disabled = !chatting && (!configured || !!chatRequest || moving);
  ui.btnChatSend.textContent = chatting ? "Cancel" : "Send";
  ui.btnChatSend.setAttribute("aria-label", chatting ? "Cancel chat request" : "Send message to your configured AI provider (live request)");
  ui.btnExtForget.disabled = !p.apiKey;
  ui.btnChatClear.disabled = moving || (!extConversations[extSeat].length && !chatting);
  ui.chatInput.disabled = !configured;
  ui.extSeat.disabled = !!chatRequest || !!extTestController;
  renderChat();
}
function activeExternalSeats() {
  const seats = mode === "ai_ai" ? [0, 1] : mode === "ai" ? [opponentSeat] : [];
  return seats.filter((side) => parseEngine(engineCfg[side]).kind === "ext");
}
function setExtSeat(seat) {
  extSeat = seat === 0 ? 0 : 1;
  extFormOpen = !extConfigured(extSeat);
  renderExt();
}
function updateExtVisibility() {
  const seats = activeExternalSeats();
  const show = seats.length > 0;
  ui.extCard.classList.toggle("hide", !show);
  if (!show) return;
  if (!seats.includes(extSeat)) {
    extSeat = seats[0];
  }
  ui.extSeatRow.classList.toggle("hide", !(mode === "ai_ai" && seats.length > 1));
  if (!extConfigured()) extFormOpen = true;
  renderExt();
}
function readExtFields() {
  const baseUrl = ui.extBase.value.trim();
  const model = ui.extModel.value.trim();
  if (!baseUrl) { ui.extNote.textContent = "Base URL is required."; return false; }
  if (!validExtBase(baseUrl)) {
    ui.extNote.textContent = "Use a URL without embedded credentials, a query or a fragment. Remote endpoints require HTTPS; HTTP is only allowed for localhost.";
    return false;
  }
  if (!model) { ui.extNote.textContent = "Model is required."; return false; }
  const effort = EXTERNAL_EFFORTS.includes(ui.extEffort.value) ? ui.extEffort.value : "auto";
  const profile = { baseUrl, protocol: ui.extProtocol.value, fullEndpoint: ui.extFullEndpoint.checked,
    model, effort, apiKey: ui.extKey.value.trim(), remember: ui.extRemember.checked,
    allowImage: ui.extImage.checked, allowMoveRequests: ui.extAllowMoves.checked };
  try { extEndpoint(profile); } catch (error) { ui.extNote.textContent = error.message; return false; }
  return profile;
}
function saveExtFromFields() {
  const profile = readExtFields();
  if (!profile) return;
  extTestController?.abort();
  const previous = extProfile();
  const conversationChanged = previous.baseUrl !== profile.baseUrl || previous.protocol !== profile.protocol ||
    previous.fullEndpoint !== profile.fullEndpoint || previous.model !== profile.model || previous.apiKey !== profile.apiKey;
  if (conversationChanged) resetExternalConversation(extSeat);
  else if (previous.effort !== profile.effort) cancelChat(extSeat);
  extProfiles[extSeat] = profile;
  extMoveCaches[extSeat].clear();
  // Cancel any scheduled or in-flight move from the old settings.
  if (engineSeat(state.turn) === extSeat && parseEngine(engineCfg[extSeat]).kind === "ext") cancelAi();
  persistExt();
  extFormOpen = false;
  ui.extNote.textContent = profile.remember && profile.apiKey ? "Saved. Key remembered on this device." : "Saved.";
  renderExt();
  render();
  const block = externalTurnBlock();
  if (block) { pauseExternalTurn(block); return; }
  if (mode === "ai_ai" && !running && engineSeat(state.turn) === extSeat) {
    status(`${turnName()} to move`, "External AI settings saved. Press Play to resume.");
  }
  scheduleAi();
}
function extComplete(messages, options = {}, profile = extProfile()) {
  return completeExternal(messages, options, profile);
}
function boardContext(position, records, legal = position.terminal ? [] : actionsFor(position)) {
  const horizontal = [], vertical = [];
  for (let i = 0; i < 64; i++) {
    if (position.hw[i]) horizontal.push(actionStr(A_H + i));
    if (position.vw[i]) vertical.push(actionStr(A_V + i));
  }
  const result = position.winner === null ? null : position.winner === 0 ? "Red" : "Blue";
  return {
    pawns: { Red: actionStr(position.pos[0]), Blue: actionStr(position.pos[1]) },
    wallsLeft: { Red: position.walls[0], Blue: position.walls[1] },
    placedWalls: [...horizontal, ...vertical],
    sideToMove: position.terminal ? null : position.turn === 0 ? "Red" : "Blue",
    movesPlayed: position.ply, result,
    recentMoves: records.slice(-12).map((m) => ({ side: m.side === 0 ? "Red" : "Blue", action: m.text })),
    legalActions: legal.map(actionStr),
  };
}
const EXTERNAL_RULES = "Quoridor 9×9: coordinates a–i and 1–9 are unflipped. Red aims for row 1, Blue row 9. " +
  "An H e5 wall spans columns e and f between rows 5 and 6. A V e5 wall spans rows 5 and 6 between columns e and f. " +
  "A pawn can step, jump over an adjacent opponent, or sidestep it when a straight jump is blocked. " +
  "Follow the legalActions list. The first pawn to reach its goal row wins.";
const EXTERNAL_SYSTEM = `${EXTERNAL_RULES} You play one seat and can chat about the game. ` +
  "The latest request specifies your side and the current board. Earlier boards are snapshots. " +
  "For a chat request, answer the message naturally. For a move request, consider any relevant strategy or preferences from the conversation. " +
  'Choose one action from the latest legalActions. A reply such as {"move":"e8"} is sufficient. ' +
  'You may add a short "say" message or a "plan" array of brief ideas if helpful. Both are optional. ' +
  'If you need an image and boardImageAvailable is true, you may reply {"want_board":true}.';
const EXTERNAL_HISTORY_PER_KIND = 12;

function externalHistory(seat) {
  return extConversations[seat].filter((turn) => turn.reply);
}
function externalMessages(history, request) {
  return [
    { role: "system", content: EXTERNAL_SYSTEM },
    ...history.flatMap((turn) => [
      { role: "user", content: turn.request }, { role: "assistant", content: turn.reply },
    ]),
    { role: "user", content: request },
  ];
}
function appendExternalTurn(seat, turn) {
  let history = extConversations[seat];
  const sameKind = history.filter((entry) => entry.kind === turn.kind);
  const limit = turn.kind === "error" ? 4 : EXTERNAL_HISTORY_PER_KIND;
  if (sameKind.length >= limit) {
    // Trim in batches so a full conversation can still reuse its prompt prefix
    // on the next few turns. A long series of moves leaves the chat intact.
    const through = sameKind[turn.kind === "error" ? 0 : 3].id;
    history = extConversations[seat] = history.filter((entry) => entry.kind !== turn.kind || entry.id > through);
  }
  history.push({ ...turn, id: ++extTurnId });
}

function parseExternalReply(content, legal) {
  const text = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  let reply;
  try { reply = JSON.parse(text); } catch { reply = { move: text }; }
  if (!reply || typeof reply !== "object") reply = { move: reply };
  const move = reply.move ?? reply.action ?? reply.best_move;
  const label = typeof move === "string" ? move.trim().replace(/\s+/g, " ").toLowerCase() : "";
  const action = typeof move === "number" ? (legal.includes(move) ? move : undefined)
    : legal.find((id) => actionStr(id).toLowerCase() === label);
  const annotation = reply.say ?? reply.comment ?? reply.message;
  const say = typeof annotation === "string" ? annotation.trim().slice(0, 500) : "";
  const plan = Array.isArray(reply.plan) ? reply.plan.filter((item) => typeof item === "string")
    .slice(0, 6).map((item) => item.trim().slice(0, 140)).filter(Boolean)
    : typeof reply.plan === "string" && reply.plan.trim() ? [reply.plan.trim().slice(0, 500)] : [];
  return { action, say, plan, wantBoard: reply.want_board === true };
}
function captureBoardImage() {
  const out = document.createElement("canvas");
  const S = 512;
  out.width = S; out.height = S;
  const g = out.getContext("2d");
  g.fillStyle = COL.paper;
  g.fillRect(0, 0, S, S);
  g.drawImage(cvs, 0, 0, S, S);
  return out.toDataURL("image/jpeg", .72);
}
async function externalMoveAction(position, side, seat, signal) {
  signal.throwIfAborted();
  const profile = extProfile(seat);
  const legal = actionsFor(position);
  const request = JSON.stringify({ task: "move", yourSide: side === 0 ? "Red" : "Blue",
    boardImageAvailable: profile.allowImage, ...boardContext(position, moves, legal) });
  const history = externalHistory(seat);
  const cacheKey = JSON.stringify([history.map((turn) => turn.id), request]);
  const hit = extMoveCaches[seat].get(cacheKey);
  if (hit) return { ...hit, cached: true, cacheRead: 0 };
  const base = externalMessages(history, request);
  let messages = base;
  let usedImage = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await extComplete(messages, { temperature: 0, maxTokens: 180, signal }, profile);
    signal.throwIfAborted();
    const parsed = parseExternalReply(res.content, legal);
    if (parsed.action !== undefined) return { ...parsed, request, cacheKey, usedImage, cacheRead: res.cacheRead };
    if (!parsed.wantBoard || !profile.allowImage || usedImage) break;
    usedImage = true;
    messages = [...base, { role: "assistant", content: '{"want_board":true}' }, {
      role: "user", content: [
        { type: "text", text: "Here is the current board. Use the coordinate labels and choose one action from legalActions." },
        { type: "image_url", image_url: { url: captureBoardImage() } },
      ],
    }];
  }
  throw new Error("The model did not return one legal action");
}
async function requestExternalMove(position, side, seat, epoch) {
  // A message already submitted to this seat belongs before its next move.
  if (chatRequest?.seat === seat) {
    status(`${engineName(side)} to move`, "Waiting for the chat reply");
    await chatRequest.done;
  }
  if (epoch !== aiEpoch || !extConfigured(seat) || !extProfile(seat).allowMoveRequests) return null;
  const moveRequest = extMoveRequest = { seat, controller: new AbortController() };
  renderExt();
  status(`${engineName(side)} is thinking`, "requesting a move from your configured endpoint");
  try {
    return await externalMoveAction(position, side, seat, moveRequest.controller.signal);
  } finally {
    if (extMoveRequest === moveRequest) {
      extMoveRequest = null;
      renderExt();
    }
  }
}
function noteExternalMove(seat, moveIndex, result) {
  const { action, request, say, plan, cacheRead, cached, cacheKey } = result;
  const move = actionStr(action);
  const reply = JSON.stringify({ move, ...(say && { say }), ...(plan.length && { plan }) });
  const cache = extMoveCaches[seat];
  if (!cached) {
    if (cache.size >= 60) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, result);
  }
  appendExternalTurn(seat, { kind: "move", moveIndex, request, reply, cacheRead, cached,
    text: [move, say, plan.length ? `Plan: ${plan.join(" → ")}` : ""].filter(Boolean).join(" · ") });
}
function renderChat() {
  ui.chatLog.innerHTML = "";
  const history = extConversations[extSeat];
  const pending = chatRequest?.seat === extSeat ? chatRequest : null;
  if (!history.length && !pending) {
    const e = document.createElement("div");
    e.className = "chat-empty";
    e.textContent = extConfigured() ? "Discuss the game or suggest a strategy." : "Set up an endpoint to chat.";
    ui.chatLog.appendChild(e);
    return;
  }
  const line = (text, label, user = false) => {
    const d = document.createElement("div");
    d.className = "chat-msg " + (user ? "user" : "bot");
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = label;
    const body = document.createElement("span");
    body.textContent = text;
    d.append(meta, body);
    ui.chatLog.appendChild(d);
  };
  for (const turn of history) {
    if (turn.question) line(turn.question, "YOU", true);
    let label = turn.cached ? "EXTERNAL · RESULT CACHE" : "EXTERNAL";
    if (turn.cacheRead) label += ` · PROMPT CACHE ${turn.cacheRead} TOK`;
    line(turn.text, label);
  }
  if (pending) line(pending.question, "YOU", true);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}
function sendChat() {
  const question = ui.chatInput.value.trim().slice(0, 500);
  const seat = extSeat;
  if (!question || chatRequest || extMoveRequest?.seat === seat) return;
  if (!extConfigured(seat)) { status("Chat needs an external endpoint", "open settings in the External AI card"); return; }
  const pending = chatRequest = { seat, question, controller: new AbortController() };
  ui.chatInput.value = "";
  pending.done = completeChat(pending);
  renderExt();
}
async function completeChat({ seat, question, controller }) {
  const request = JSON.stringify({ task: "chat", yourSide: externalColour(seat), ...boardContext(state, moves), message: question });
  const messages = externalMessages(externalHistory(seat), request);
  try {
    const { content, cacheRead } = await extComplete(messages, { temperature: 0.3, maxTokens: 420, signal: controller.signal }, extProfile(seat));
    if (controller.signal.aborted) return;
    const reply = content.slice(0, 6000);
    appendExternalTurn(seat, { kind: "chat", request, question, reply, cacheRead, text: reply });
  } catch (err) {
    if (!controller.signal.aborted) appendExternalTurn(seat, { kind: "error", question, text: "Request failed: " + err.message });
  } finally {
    if (chatRequest?.controller === controller) {
      chatRequest = null;
      renderExt();
    }
  }
}

async function chooseFor(side, position, epoch) {
  const seat = engineSeat(side);
  const cfg = parseEngine(engineCfg[seat]);
  if (position.walls[0] + position.walls[1] <= 1) {
    const { action, stats } = await searchAlphaBeta(position, { depth: 6, ms: cfg.ms ?? 1200 });
    if (epoch !== aiEpoch) return null;
    lastInfo = `Solved endgame · ${stats.ms} ms`;
    return action;
  }
  if (cfg.kind === "sigma") {
    const search = sigmaQueue.then(async () => {
      if (epoch !== aiEpoch) return null;
      await ensureSigma();
      if (epoch !== aiEpoch) return null;
      const budget = cfg.sims >= 2048 ? 4000 : cfg.sims >= 1024 ? 3200 : cfg.sims >= 512 ? 2400 : 1400;
      const options = {
        temperature: 0,
        ms: budget,
        cancelled: () => epoch !== aiEpoch,
        yieldToUI: true,
      };
      let ag = sigmaAgentFor(side, cfg);
      const t0 = performance.now();
      let a;
      try {
        a = await ag.choose(position, options);
      } catch (error) {
        if (!sigmaBatch) throw error;
        console.warn("Sigma GPU inference failed, retrying on CPU", error);
        sigmaGpuUnavailable = true;
        sigmaNet.session.release();
        sigmaNet = null;
        sigmaAgents = { 0: null, 1: null };
        if (epoch !== aiEpoch) return null;
        await ensureSigma();
        if (epoch !== aiEpoch) return null;
        ag = sigmaAgentFor(side, cfg);
        a = await ag.choose(position, options);
      }
      if (epoch !== aiEpoch) return null;
      lastInfo = ag.lastSims || !ag.lastTactic
        ? `Sigma · ${ag.lastSims}/${cfg.sims} simulations · ${sigmaBatch ? "GPU" : "CPU"} · ${Math.round(performance.now() - t0)} ms`
        : `Sigma · ${ag.lastTactic}`;
      return a;
    });
    sigmaQueue = search.catch(() => {});
    return search;
  }
  if (cfg.kind === "guided" || cfg.kind === "champion") {
    const champion = cfg.kind === "champion";
    const search = sigmaQueue.then(() => searchGuided(position, {
      ms: cfg.ms,
      loadNet: champion ? ensureChampion : ensureSigma,
      search: (options) => searchAlphaBeta(position, { depth: cfg.depth, policyWeight: champion ? 220 : 170, ...options }),
      cancelled: () => epoch !== aiEpoch,
      onModelError: (error) => {
        lastAiMetrics = { ...lastAiMetrics, modelError: error.message };
        console.warn("Guided policy unavailable; using Detour", error);
      },
      onStage: (stage) => {
        if (epoch !== aiEpoch) return;
        const ready = champion ? championReady : !!sigmaNet;
        status(`${engineName(side)} is thinking`, stage === "loading" && !ready ? "Loading AI files · first use may take longer"
          : stage === "inference" ? "Evaluating this position" : "Searching moves on this device");
      },
    }));
    sigmaQueue = search.catch(() => {});
    const result = await search;
    if (!result || epoch !== aiEpoch) return null;
    const label = result.guided ? searchName(cfg.kind) : "Alpha-beta";
    lastAiMetrics = { ...lastAiMetrics, loadMs: result.loadMs, inferenceMs: result.inferenceMs, searchMs: result.stats.ms, guided: result.guided };
    lastInfo = result.stats.endgame ? `Solved endgame · ${result.ms} ms` : `${label} · depth ${result.stats.depth} · ${result.ms} ms`;
    return result.action;
  }
  const { action: a, stats: st } = await searchAlphaBeta(position, cfg);
  if (epoch !== aiEpoch) return null;
  lastInfo = st.endgame ? `Solved endgame · ${st.ms} ms` : `Alpha-beta · depth ${st.depth} · ${st.ms} ms`;
  return a;
}

// ---------------------------------------------------------------- game flow
function canPlay() {
  if (!state || state.terminal) return false;
  if (mode === "hotseat") return true;
  if (mode === "room") return roomReady && !resignPending && state.turn === mySide;
  if (mode === "ai") return state.turn === humanSide;
  return false;
}
function turnName() { return state.turn === 0 ? "Red" : "Blue"; }
function boardHint() {
  return boardTool === "auto" ? "Tap a highlighted square, or drag a wall onto the board."
    : "Drag a wall onto the board, or tap the intersection at its centre.";
}
function humanTurn() {
  if (!state || state.terminal) return;
  busy = false;
  render();
  if (mode === "room") {
    if (state.turn === mySide) status(`Your move (${turnName()})`, boardHint());
    else status("Waiting for the other player", "");
    return;
  }
  if (canPlay()) status(`Your move (${turnName()})`,
    boardHint() + (lastInfo ? `   ·   ${lastInfo}` : ""));
  prewarmEngine();
}
function clearAiTimer() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
}
function cancelAi() {
  aiEpoch++;
  aiRetryAvailable = false;
  cancelAlphaSearch?.();
  extMoveRequest?.controller.abort();
  extMoveRequest = null;
  clearAiTimer();
  busy = false;
}
function scheduleAi(delay = 0) {
  clearAiTimer();
  if (!state || state.terminal) return;
  if (mode !== "ai" && mode !== "ai_ai") return;
  if (mode === "ai" && state.turn === humanSide) return;
  if (mode === "ai_ai" && !running) return;
  const epoch = aiEpoch;
  aiTimer = setTimeout(() => { if (epoch === aiEpoch) aiTurn(); }, Math.max(0, delay));
}
async function aiTurn() {
  if (!state || state.terminal || busy) return;
  aiRetryAvailable = false;
  if (mode === "ai" && state.turn === humanSide) return;
  if (mode === "ai_ai" && !running) return;
  const epoch = aiEpoch;
  const position = state;
  const side = position.turn;
  const seat = engineSeat(side);
  const kind = parseEngine(engineCfg[seat]).kind;
  const turnStarted = performance.now();
  lastAiMetrics = null;
  const block = externalTurnBlock();
  if (block) { pauseExternalTurn(block); return; }
  busy = true;
  updatePlayers();
  updateButtons();
  status(`${engineName(side)} is thinking`, (kind === "sigma" || kind === "guided" || kind === "champion")
    ? ((kind === "champion" ? championReady : sigmaNet) ? "Searching moves on this device" : "Loading AI files · first use may take longer")
    : kind === "ext" ? "requesting a move from your configured endpoint"
    : "alpha-beta search");
  await new Promise((r) => setTimeout(r, 35));
  if (epoch !== aiEpoch) return;
  const delayedBlock = externalTurnBlock();
  if (delayedBlock) { pauseExternalTurn(delayedBlock); return; }
  let a = null;
  let external = null;
  try {
    if (kind === "ext") {
      external = await requestExternalMove(position, side, seat, epoch);
      a = external?.action;
    } else {
      a = await chooseFor(side, position, epoch);
    }
  } catch (err) {
    if (epoch !== aiEpoch) return;
    const failedBlock = externalTurnBlock();
    if (failedBlock) { pauseExternalTurn(failedBlock); return; }
    console.error(err);
    busy = false;
    aiRetryAvailable = true;
    if (mode === "ai_ai") running = false;
    lastInfo = "";
    render();
    status(kind === "ext" ? "External AI request failed" : "AI engine failed",
      err?.message || "No move was made. Retry when ready.");
    return;
  }
  if (epoch !== aiEpoch) return;
  const finalBlock = externalTurnBlock();
  if (finalBlock) { pauseExternalTurn(finalBlock); return; }
  if (!actionsFor(position).includes(a)) {
    busy = false;
    aiRetryAvailable = true;
    if (mode === "ai_ai") running = false;
    render();
    status(kind === "ext" ? "External AI returned no legal move" : "AI returned no legal move",
      "No move was made. Check the engine response and retry.");
    return;
  }
  busy = false;
  aiRetryAvailable = false;
  const totalMs = Math.round(performance.now() - turnStarted);
  lastAiMetrics = { ...lastAiMetrics, engine: kind, totalMs, modelThreads: globalThis.ort?.env.wasm.numThreads || null };
  ui.boardStatus.title = `Last AI turn: ${totalMs} ms${lastAiMetrics.inferenceMs !== undefined ? ` (model ${lastAiMetrics.inferenceMs} ms, search ${lastAiMetrics.searchMs} ms, loading ${lastAiMetrics.loadMs} ms)` : ""}`;
  if (external) {
    lastExtSay = external.say || "";
    lastInfo = `external ${extProfile(seat).model}${external.cached ? " · result cache" : ""}${external.cacheRead ? ` · prompt cache ${external.cacheRead} tok` : ""}${external.usedImage ? " · vision" : ""}`;
  }
  const over = applyAction(a, { external });
  if (!over) afterMove();
}
function afterMove() {
  if (!state || state.terminal) return;
  if (mode === "ai") {
    if (state.turn === humanSide) humanTurn();
    else scheduleAi(0);
  } else if (mode === "hotseat") {
    humanTurn();
  } else if (mode === "ai_ai") {
    if (running) scheduleAi(speed * 1000);
    else { render(); status(`${turnName()} to move`, "autoplay paused"); }
  } else if (mode === "room") {
    if (state.turn === mySide) humanTurn();
    else status("Waiting for the other player", "");
  }
}
function applyAction(a, { remote = false, external = null } = {}) {
  if (!state || state.terminal || !state.legal().includes(a)) return false;
  const before = state;
  const side = before.turn;
  const beforePly = before.ply;
  state = state.doAction(a);
  hover = null;
  history.push(state);
  lastAction = a;
  for (const ag of Object.values(sigmaAgents)) if (ag) ag.advance(a);
  if (external) noteExternalMove(engineSeat(side), moves.length, external);
  moves.push({ n: Math.floor(beforePly / 2) + 1, side, a, text: actionStr(a) });
  if (!remote) netSend({ t: "move", a, ply: beforePly, round: roomRound });
  if (state.terminal) { finish(); return true; }
  render();
  return false;
}
function finish() {
  clearAiTimer();
  running = false;
  busy = false;
  if (mode === "ai" || mode === "ai_ai") {
    finishedPlayers ??= [0, 1].map((side) => ({ name: playerName(side), tag: playerTag(side) }));
  }
  if (mode !== "replay" && mode !== "room") saveFinishedGame();
  render();
  presentResult();
}
function newGame({ broadcast = true } = {}) {
  if (mode === "replay") { setMode("ai"); return; }
  if (mode === "room" && broadcast) { roomRematchClick(); return; }
  roomRematchPending = false;
  roomRequest = null;
  roomNotice = "";
  resignedSide = null;
  resignPending = false;
  cancelAi();
  resetExternalConversations();
  replayPlaying = false;
  replayTimer = null;
  state = State.new();
  history = [state];
  moves = [];
  lastAction = null;
  busy = false;
  hover = null;
  lastInfo = "";
  lastExtSay = "";
  lastAiMetrics = null;
  ui.boardStatus.title = "";
  savedLines = new Set();
  resetAgents();
  updateViewFlip();
  render();
  if (mode === "room") {
    if (roomReady) afterMove();
    return;
  }
  if (mode === "ai") {
    if (state.turn === humanSide) humanTurn();
    else scheduleAi(0);
  } else if (mode === "ai_ai") {
    running = true;
    updateButtons();
    status(`${engineName(0)} vs ${engineName(1)}`, "autoplay running");
    scheduleAi(speed * 1000);
  } else if (mode === "hotseat") {
    humanTurn();
  }
}
function updateViewFlip() {
  const playingBlue = mode === "ai" ? humanSide === 1 : mode === "room" && mySide === 1;
  viewFlip = playingBlue && viewBottomSetting;
  if (geo) draw();
}
function undoIndex() {
  if (mode === "hotseat") return history.length - 2;
  if (mode !== "ai") return -1;
  for (let index = history.length - 2; index >= 0; index--) {
    if (history[index].turn === humanSide) return index;
  }
  return -1;
}
function refreshLocalPosition() {
  lastAction = moves.at(-1)?.a ?? null;
  hover = null;
  lastInfo = "";
  lastExtSay = "";
  sigmaAgents = { 0: null, 1: null };
  updateViewFlip();
  render();
  afterMove();
}
function undo() {
  const index = undoIndex();
  if (index < 0) return;
  cancelAi();
  state = history[index];
  history.length = index + 1;
  moves.length = index;
  cancelChat();
  for (const seat of [0, 1]) {
    extConversations[seat] = extConversations[seat].filter((turn) => turn.kind !== "move" || turn.moveIndex < index);
  }
  refreshLocalPosition();
}
function flipSides() {
  if (mode === "ai") {
    if (state.terminal) return;
    cancelAi();
    humanSide = 1 - humanSide;
    persistPrefs();
    refreshLocalPosition();
  } else if (mode === "ai_ai") {
    [engineCfg[0], engineCfg[1]] = [engineCfg[1], engineCfg[0]];
    persistPrefs();
    newGame();
  }
}
function saveFinishedGame() {
  if (!saveEnabled) return;
  const actions = moves.map((move) => move.a);
  const line = actions.join(",");
  if (savedLines.has(line)) return;
  savedLines.add(line);
  const rec = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    mode, p0: playerName(0), p1: playerName(1),
    winner: state.winner, moves: actions, plies: actions.length,
  };
  savedGames.unshift(rec);
  if (savedGames.length > MAX_SAVED) savedGames.length = MAX_SAVED;
  persistSaved();
  selectedSavedId = rec.id;
  renderSaved();
  updateButtons();
}

// ---------------------------------------------------------------- replay
function clearReplay() {
  replayPlaying = false;
  if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
  replayStates = null;
  replayMoves = [];
  replayRecord = null;
  replayIdx = 0;
}
function loadRecord(rec, atEnd = false) {
  if (!rec || !Array.isArray(rec.moves)) {
    throw new Error("Choose a Quoridor game file with a move list.");
  }
  const states = [State.new()];
  const records = [];
  for (const [index, action] of rec.moves.entries()) {
    const position = states.at(-1);
    if (position.terminal || !position.legal().includes(action)) {
      throw new Error(`Move ${index + 1} is invalid for that position.`);
    }
    states.push(position.doAction(action));
    records.push({ n: Math.floor(index / 2) + 1, side: position.turn, a: action, text: actionStr(action) });
  }
  if (mode !== "replay") ui.continueMode.value = mode === "hotseat" ? "hotseat" : (humanSide === 0 ? "red" : "blue");
  cancelAi();
  resetExternalConversations();
  clearReplay();
  mode = "replay";
  running = false;
  hover = null;
  replayStates = states;
  replayMoves = records;
  replayRecord = rec;
  updateViewFlip();
  setReplay(atEnd ? records.length : 0);
  ui.replayCard.scrollIntoView({ block: "nearest" });
}
function continueReplay() {
  if (!replayStates || state.terminal) return;
  cancelAi();
  history = replayStates.slice(0, replayIdx + 1);
  const playAs = ui.continueMode.value;
  clearReplay();
  mode = playAs === "hotseat" ? "hotseat" : "ai";
  if (mode === "ai") humanSide = playAs === "blue" ? 1 : 0;
  running = false;
  savedLines = new Set();
  persistPrefs();
  refreshLocalPosition();
  ui.btnNew.focus();
}
function setReplay(idx) {
  if (!replayStates) return;
  replayIdx = clamp(idx, 0, replayStates.length - 1);
  state = replayStates[replayIdx];
  moves = replayMoves.slice(0, replayIdx);
  lastAction = moves.length ? moves[moves.length - 1].a : null;
  render();
  const players = `${replayRecord.p0 || "Red"} vs ${replayRecord.p1 || "Blue"}`;
  const result = state.winner === null ? `${turnName()} to move` : `${state.winner === 0 ? "Red" : "Blue"} wins`;
  status(`${result} · move ${replayIdx}`, players);
}
function jumpReplay(index) {
  if (!replayStates) return;
  replayPlaying = false;
  clearTimeout(replayTimer);
  replayTimer = null;
  setReplay(index);
}
function toggleReplayAuto() {
  if (!replayStates) return;
  replayPlaying = !replayPlaying;
  scheduleReplay();
  updateButtons();
}
function scheduleReplay() {
  clearTimeout(replayTimer);
  replayTimer = null;
  if (!replayPlaying) return;
  replayTimer = setTimeout(() => {
    const next = replayIdx + 1;
    if (next >= replayStates.length - 1) replayPlaying = false;
    setReplay(next);
    scheduleReplay();
  }, replaySpeed * 1000);
}
function loadSelectedSaved() {
  if (mode === "room") return;
  const rec = savedGames.find((r) => r.id === selectedSavedId);
  if (!rec) { status("Select a saved game first", "pick one from the list"); return; }
  try {
    ui.archiveNote.textContent = "";
    loadRecord(rec);
  } catch (error) {
    ui.archiveNote.textContent = error.message;
  }
}
async function importGame() {
  const file = ui.importFile.files[0];
  ui.importFile.value = "";
  if (!file || mode === "room") return;
  try {
    if (file.size > MAX_GAME_FILE_BYTES) throw new Error("Choose a game file smaller than 64 KB.");
    let record;
    try { record = JSON.parse(await file.text()); }
    catch { throw new Error("This file is not valid JSON."); }
    if (mode === "room") return;
    if (!record || typeof record !== "object" ||
        (record.format !== undefined && (record.format !== GAME_FILE || record.version !== 1))) {
      throw new Error("This game file format is unsupported.");
    }
    loadRecord({
      moves: record.moves,
      p0: typeof record.p0 === "string" ? record.p0.slice(0, 80) : "Red",
      p1: typeof record.p1 === "string" ? record.p1.slice(0, 80) : "Blue",
    }, true);
    ui.archiveNote.textContent = `Imported ${file.name}.`;
  } catch (error) {
    ui.archiveNote.textContent = error.message;
  }
}
function exportPosition(currentOnly = false) {
  if (ui.btnExport.disabled) return;
  const fullReplay = !!replayStates && !currentOnly;
  const exportedMoves = fullReplay ? replayMoves : moves;
  const position = {
    format: GAME_FILE, version: 1,
    p0: playerName(0), p1: playerName(1),
    moves: exportedMoves.map((move) => move.a),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(position, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `quoridor-${fullReplay ? "game" : "move"}-${exportedMoves.length}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function deleteSaved() {
  if (!savedGames.length) return;
  if (!window.confirm("Delete all saved games in this browser?")) return;
  savedGames = [];
  savedLines.clear();
  selectedSavedId = null;
  persistSaved();
  renderSaved();
  updateButtons();
}

// ---------------------------------------------------------------- modes / room
function setMode(next) {
  if (!["ai", "hotseat", "ai_ai", "replay", "room"].includes(next)) return;
  cancelAi();
  clearReplay();
  resetPeer();
  roomReady = false;
  roomCode = null;
  mode = next;
  running = false;
  savedLines = new Set();
  if (next === "room") {
    resetExternalConversations();
    state = State.new();
    history = [state];
    moves = [];
    lastAction = null;
    updateModeButtons();
    updateViewFlip();
    render();
    status("Room mode", "Create a room or join with a code.");
    roomMsg("Use Create room for an invitation that works across most networks.");
    return;
  }
  if (next === "replay") {
    resetExternalConversations();
    state = State.new();
    history = [state];
    moves = [];
    lastAction = null;
    updateModeButtons();
    updateViewFlip();
    render();
    status("Choose a game to replay", "Open a saved game or import a Quoridor JSON file.");
    return;
  }
  persistPrefs();
  updateModeButtons();
  newGame();
}

function roomRematchMessage() {
  if (mode !== "room") return "";
  if (roomRequest) {
    const { swap, outgoing, accepted, cancelling, crossed } = roomRequest;
    return cancelling ? "Cancelling the rematch request…"
      : outgoing ? `${swap ? "Swap rematch" : "Rematch"} requested. Waiting for your opponent.`
      : accepted ? "Rematch accepted. Starting the new game…"
      : crossed ? `Your requests use different sides. Accept to ${swap ? "swap sides" : "keep the same sides"}.`
      : swap ? "Your opponent wants a rematch with sides swapped."
      : "Your opponent wants a rematch with the same sides.";
  }
  if (!roomRematchPending) return roomNotice;
  return roomRole === "guest" ? "Rematch requested. Waiting for the host." : "Your opponent requested a rematch.";
}
function updateRestartButtons() {
  const inRoom = mode === "room";
  const guest = inRoom && roomRole === "guest";
  const canRematch = inRoom && roomReady && state.terminal;
  if (ui.btnRoomResign) {
    ui.btnRoomResign.hidden = !(inRoom && roomReady && roomSeatSupport && !state.terminal);
    ui.btnRoomResign.disabled = resignPending;
    ui.btnRoomResign.textContent = resignPending ? "Resigning…" : "Resign";
  }
  const incoming = roomRequest && !roomRequest.outgoing && !roomRequest.accepted;
  let label = "Request rematch";
  if (incoming) label = roomRequest.swap ? "Accept & swap sides" : "Accept rematch";
  else if (roomRequest || (guest && roomRematchPending)) label = "Rematch pending…";
  else if (!roomSeatSupport && !guest) label = roomRematchPending ? "Accept rematch" : "Awaiting rematch request";
  ui.btnNew.hidden = inRoom && !canRematch;
  ui.btnNew.textContent = inRoom ? label : "New game";
  ui.btnResultNew.textContent = inRoom ? label : "Play again";
  ui.btnNew.disabled = ui.btnResultNew.disabled = inRoom && (!canRematch ||
    (roomRequest ? !incoming : !roomSeatSupport && (guest ? roomRematchPending : !roomRematchPending)));
  for (const button of [ui.btnRoomSwap, ui.btnResultSwap]) if (button) {
    button.hidden = !canRematch || !roomSeatSupport || !!roomRequest;
  }
  for (const button of [ui.btnRoomSwapDecline, ui.btnResultSwapDecline]) if (button) {
    button.hidden = !canRematch || !(incoming || roomRequest?.outgoing);
    button.disabled = !!roomRequest?.cancelling;
    button.textContent = roomRequest?.outgoing ? "Cancel request" : "Decline";
  }
  if (ui.roomRematch) {
    const message = roomRematchMessage();
    ui.roomRematch.hidden = !message;
    if (ui.roomRematch.textContent !== message) ui.roomRematch.textContent = message;
  }
}
function updateRoomRequests() {
  updateRestartButtons();
  updateResult();
}
function startRoomRematch(swap, id = null) {
  if (roomRole !== "host" || !roomReady || !state.terminal) return;
  if (swap) mySide = 1 - mySide;
  roomRound++;
  roomRematchId = id;
  newGame({ broadcast: false });
  syncRoom();
  showRoomSeat();
}
function roomRematchClick(swap = false, revoke = false) {
  if (mode !== "room" || !roomReady || !state.terminal) return;
  if (!roomSeatSupport) {
    // Legacy Red-host connections still require the guest's old-style request.
    if (swap || revoke) return;
    if (roomRole === "host") {
      if (roomRematchPending) startRoomRematch(false);
    } else if (!roomRematchPending && netSend({ t: "askRestart" })) {
      roomRematchPending = true;
      updateRoomRequests();
    }
    return;
  }
  if (!roomRequest && !revoke) {
    const id = newRelayCode();
    if (!netSend({ t: "rematchOffer", id, swap, round: roomRound })) return;
    roomRequest = { id, swap, outgoing: true };
  } else if (roomRequest && !roomRequest.accepted && !roomRequest.cancelling) {
    const { id, outgoing } = roomRequest;
    if (revoke) {
      if (!netSend({ t: "rematchRevoke", id, round: roomRound })) return;
      // The host might already have accepted. Keep this offer eligible for
      // a commit until the host confirms that cancellation took effect.
      if (outgoing && roomRole === "guest") roomRequest.cancelling = true;
      else roomRequest = null;
    } else if (!outgoing) {
      if (roomRole === "host") { startRoomRematch(roomRequest.swap, id); return; }
      if (!netSend({ t: "rematchAccept", id, round: roomRound })) return;
      roomRequest.accepted = true;
    }
  }
  roomNotice = "";
  updateRoomRequests();
}
function setRoomResignation(position, side) {
  const result = position.clone();
  result.winner = 1 - side;
  return result;
}
function hostSettleResignation(side) {
  if (roomRole !== "host" || !roomReady) return;
  // The host resolves a goal and a resignation that cross in transit.
  if (!state.terminal) {
    resignedSide = side;
    state = setRoomResignation(state, side);
    history[history.length - 1] = state;
    finish();
  }
  syncRoom();
}
function canResignRoom() {
  return mode === "room" && roomReady && roomSeatSupport && !state.terminal && !resignPending;
}
function resignRoom() {
  if (!canResignRoom()) return;
  if (roomRole === "host") {
    hostSettleResignation(mySide);
  } else if (netSend({ t: "resign", round: roomRound })) {
    resignPending = true;
    render();
    status("Resigning…", "Waiting for the room to confirm the result.");
  }
}
function roomMsg(text) { ui.roomMsg.textContent = text; }
function selectedHostSide() { return ui.roomHostSide?.value === "1" ? 1 : 0; }
function showRoomSeat() { roomMsg(`Connected · room ${roomCode} · you are ${mySide === 0 ? "Red" : "Blue"}.`); }
function peerAvailable() { return typeof window.Peer === "function"; }
const ROOM_TIMEOUT = 12_000;
let roomTimer = null;
let relayController = null;

async function relayRoom(joinCode) {
  resetPeer();
  const controller = relayController = new AbortController();
  const host = !joinCode;
  roomRole = host ? "host" : "guest";
  mySide = host ? selectedHostSide() : 1;
  if (host) newGame({ broadcast: false });
  else { updateViewFlip(); render(); }
  const copy = $("btnCopyRoom");
  status(host ? "Creating a room…" : "Joining the room…", "Connecting to the room relay.");
  roomMsg("Connecting to the room relay.");
  try {
    const code = joinCode || (ROOM_WORKER_URL ? "W-" : "R-") + newRelayCode();
    const options = {
      signal: controller.signal,
      onGuest: bindConn,
      onStatus(online, error) {
        if (controller.signal.aborted || relayController !== controller) return;
        if (error) roomMsg(error.message);
        else if (roomCode === code && !online) roomMsg(host
          ? "Room relay disconnected. Waiting for it to reconnect…"
          : "Room relay disconnected. Rejoin with the same invitation.");
        else if (host && roomCode === code && !conn) roomMsg("Share the invitation link with one opponent.");
      },
    };
    let room;
    if (code.startsWith("W-")) {
      if (!ROOM_WORKER_URL) throw new Error("This page does not have a WebSocket room relay configured.");
      const { openSocketRoom } = await import("./room-websocket.js?v=websocket-room");
      room = await openSocketRoom(ROOM_WORKER_URL, code, host, options);
    } else {
      const { openRelayRoom } = await import("./room-relay.js?v=websocket-room");
      room = await openRelayRoom(code, host, options);
    }
    if (relayController !== controller) return;
    roomCode = code;
    if (!host) { bindConn(room.join()); return; }
    ui.roomCode.textContent = code;
    ui.roomCode.classList.add("relay-code");
    ui.roomCode.style.display = "block";
    copy.hidden = false;
    roomMsg("Share the invitation link with one opponent.");
    status("Waiting for an opponent", "Keep this page open.");
  } catch (error) {
    if (relayController !== controller) return;
    resetPeer();
    status(host ? "Could not create a room" : "Could not join the room", "Try again or start a Direct room with your opponent.");
    roomMsg(error.message || String(error));
  }
}

function roomInvite(code) {
  const url = new URL(location.href);
  url.hash = "room=" + code;
  return url.href;
}

function codeFromInput(text) {
  const input = text.trim();
  try { return new URL(input).hash.match(ROOM_INVITE)?.[1] || input; }
  catch { return input; }
}

function joinFromInput() {
  const code = codeFromInput(ui.joinCode.value);
  if (isRelayCode(code)) {
    ui.joinCode.value = code;
    void relayRoom(code);
  } else if (code.startsWith("R-") || code.startsWith("W-")) {
    roomMsg("Paste the full invitation link or room code.");
  } else void joinRoom();
}

function waitOpen(p) {
  if (p.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      p.off("open", opened);
      p.off("error", finish);
      p.off("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const opened = () => finish();
    const closed = () => finish(new Error("Room connection closed before opening"));
    const timer = setTimeout(() => finish(new Error("Room server did not respond")), ROOM_TIMEOUT);
    p.on("open", opened);
    p.on("error", finish);
    p.on("close", closed);
  });
}
function watchPeer(p) {
  p.on("error", (error) => {
    if (peer !== p) return;
    if (roomRole === "guest" && !roomReady && !state.terminal) {
      status("Could not join the Direct room", "Check the code, or ask the host for a W- invitation.");
    }
    if (!roomReady) {
      const hint = roomRole === "host" ? "Use Create room for a W- invitation instead."
        : "Check the code, or ask the host for a W- invitation.";
      roomMsg(`Direct room connection failed. ${hint}`);
    }
  });
  p.on("disconnected", () => {
    if (peer !== p || p.destroyed) return;
    roomMsg("Signalling disconnected. Attempting to reconnect…");
    try { p.reconnect(); } catch (error) { roomMsg(error.message || String(error)); }
  });
}
async function createRoom() {
  if (!peerAvailable()) { roomMsg("Room play needs PeerJS and an internet connection."); return; }
  resetPeer();
  roomRole = "host";
  mySide = selectedHostSide();
  newGame({ broadcast: false });
  status("Creating a room…", "Connecting to the room server.");
  const code = randomCode();
  const p = peer = new window.Peer("q9-" + code.toLowerCase(), { debug: 1 });
  try {
    await waitOpen(p);
    if (peer !== p) return;
    roomCode = code;
    ui.roomCode.textContent = code;
    ui.roomCode.style.display = "block";
    roomMsg("Share this code with one opponent.");
    status("Waiting for an opponent", `Room ${code}`);
    watchPeer(p);
    p.on("connection", (channel) => {
      if (peer !== p || conn) { channel.close(); return; }
      bindConn(channel);
    });
  } catch (error) {
    if (peer !== p) return;
    resetPeer();
    status("Could not create a Direct room", "Use Create room for a W- invitation instead.");
    roomMsg("Could not reach the Direct room server. Use Create room instead.");
  }
}
async function joinRoom() {
  if (!peerAvailable()) { roomMsg("Room play needs PeerJS and an internet connection."); return; }
  const code = ui.joinCode.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) { roomMsg("Enter the four-character room code."); return; }
  resetPeer();
  roomRole = "guest";
  mySide = 1;
  updateViewFlip();
  roomCode = code;
  status("Joining the room…", `Room ${code}`);
  roomMsg("Connecting to the host.");
  render();
  const p = peer = new window.Peer({ debug: 1 });
  try {
    await waitOpen(p);
    if (peer !== p) return;
    watchPeer(p);
    bindConn(p.connect("q9-" + code.toLowerCase(), { reliable: true }));
  } catch (error) {
    if (peer !== p) return;
    resetPeer();
    status("Could not join the Direct room", "Ask the host to create a room and share the W- invitation.");
    roomMsg("Could not reach the Direct room server. Ask the host for a W- invitation.");
  }
}
function bindConn(channel) {
  conn = channel;
  roomSeatSupport = false;
  const fail = (text) => {
    if (conn !== channel) return;
    clearTimeout(roomTimer);
    conn = null;
    roomReady = false;
    roomRematchPending = false;
    roomRequest = null;
    roomNotice = "";
    roomSeatSupport = false;
    resignPending = false;
    if (ui.roomResignDialog?.open) ui.roomResignDialog.close();
    channel.close();
    render();
    const reconnect = roomRole === "host" ? `Opponent can rejoin room ${roomCode}.` : `Join room ${roomCode} again to resume.`;
    const guidance = relayController ? reconnect : roomRole === "host"
      ? "If Direct keeps failing, use Create room to share a W- invitation."
      : "Ask the host to use Create room and send you a W- invitation.";
    if (!state.terminal) status("Room disconnected", guidance);
    roomMsg(`${text} ${guidance}`);
  };
  roomTimer = setTimeout(() => fail(roomRole === "host" && mySide === 1 && channel.open
    ? "A Blue-host room needs an updated page. Ask your opponent to refresh and rejoin."
    : relayController ? "The other player did not respond through the room relay."
    : "Direct connection timed out. Some networks block peer-to-peer connections."), ROOM_TIMEOUT);
  const onOpen = () => {
    if (conn !== channel) return;
    if (roomRole === "guest") {
      netSend({ t: "roomHello", seats: ROOM_SEATS_VERSION });
      return;
    }
    // An old guest always assumes it is Blue; don't start a Blue-host
    // match with one. Red-host rooms retain the old sync handshake.
    if (mySide === 1 && !roomSeatSupport) return;
    hostReady();
  };
  channel.on("open", onOpen);
  channel.on("data", (data) => { if (conn === channel) handleNet(data); });
  channel.on("close", () => fail("The connection closed."));
  channel.on("error", (error) => fail(error.message || String(error)));
  if (channel.open) onOpen();
}
function hostReady() {
  if (!roomReady) {
    clearTimeout(roomTimer);
    roomReady = true;
    syncRoom();
    showRoomSeat();
    showRoomPosition();
  } else {
    updateRestartButtons();
  }
}
function showRoomPosition() {
  render();
  if (state.terminal) finish();
  else afterMove();
}
function syncRoom() {
  netSend({ t: "sync", moves: moves.map((move) => move.a), hostSide: mySide,
    seats: ROOM_SEATS_VERSION, round: roomRound, resigned: resignedSide, rematch: roomRematchId });
}
function handleNet(message) {
  if (!message || typeof message !== "object" || mode !== "room") return;
  if (message.t === "roomHello" && roomRole === "host" && message.seats === ROOM_SEATS_VERSION) {
    roomSeatSupport = true;
    hostReady();
    return;
  }
  if (message.t === "sync" && roomRole === "guest") {
    if (!Array.isArray(message.moves)) return;
    const seatProtocol = message.seats === ROOM_SEATS_VERSION;
    if (roomReady && roomSeatSupport && !seatProtocol) return;
    const round = seatProtocol ? message.round : 0;
    const hostSide = seatProtocol ? message.hostSide : 0;
    if (!Number.isSafeInteger(round) || round < roomRound || (hostSide !== 0 && hostSide !== 1)) return;
    if (roomReady && round === roomRound && mySide !== 1 - hostSide) return;
    if (roomReady && seatProtocol && round > roomRound) {
      const consent = roomRequest && (roomRequest.outgoing || roomRequest.accepted);
      const expected = roomRequest?.swap ? 1 - mySide : mySide;
      if (round !== roomRound + 1 || !consent || message.rematch !== roomRequest.id || 1 - hostSide !== expected) return;
    }
    let position = State.new();
    const records = [], states = [position];
    for (const action of message.moves) {
      if (position.terminal || !actionsFor(position).includes(action)) return;
      records.push({ n: Math.floor(position.ply / 2) + 1, side: position.turn, a: action, text: actionStr(action) });
      position = position.doAction(action);
      states.push(position);
    }
    const resigned = seatProtocol ? message.resigned ?? null : null;
    if (resigned !== null) {
      if (position.terminal || (resigned !== 0 && resigned !== 1)) return;
      position = setRoomResignation(position, resigned);
      states[states.length - 1] = position;
    }
    if (!seatProtocol && roomReady && state.terminal && !position.terminal && !roomRematchPending) {
      roomMsg("An older host page tried to restart without a request. Ask the host to refresh and create a new room.");
      return;
    }
    clearTimeout(roomTimer);
    roomReady = true;
    if (round !== roomRound || !position.terminal) {
      roomRematchPending = false;
      roomRequest = null;
      roomNotice = "";
    }
    roomRound = round;
    resignedSide = resigned;
    if (position.terminal) resignPending = false;
    roomSeatSupport = seatProtocol;
    mySide = 1 - hostSide;
    state = position;
    history = states;
    moves = records;
    lastAction = records.at(-1)?.a ?? null;
    hover = null;
    updateViewFlip();
    showRoomSeat();
    showRoomPosition();
    return;
  }
  if (!roomReady) return;
  if (message.t === "move") {
    if (roomSeatSupport && message.round !== roomRound) return;
    if (state.terminal || state.turn === mySide || message.ply !== state.ply || !actionsFor(state).includes(message.a)) {
      if (roomRole === "host") syncRoom();
      else netSend({ t: "resync" });
      return;
    }
    if (!applyAction(message.a, { remote: true })) afterMove();
  } else if (message.t === "resync" && roomRole === "host") {
    syncRoom();
  } else if (message.t === "resign" && roomRole === "host" && roomSeatSupport && message.round === roomRound) {
    hostSettleResignation(1 - mySide);
  } else if (message.t === "restart" && roomRole === "guest" && !roomSeatSupport && roomRematchPending) {
    // Compatibility with a host using the earlier restart message.
    newGame({ broadcast: false });
  } else if (message.t === "askRestart" && roomRole === "host" && !roomSeatSupport && state.terminal) {
    roomRematchPending = true;
    updateRoomRequests();
  } else if (roomSeatSupport && state.terminal && message.round === roomRound) {
    if (message.t === "rematchOffer" && typeof message.swap === "boolean" &&
        typeof message.id === "string" && /^[\w-]{22}$/.test(message.id)) {
      // The host's offer is the common ID when requests cross. Matching
      // choices already express consent, but the guest must acknowledge
      // that ID before the host can commit the next round.
      if (roomRequest && !(roomRole === "guest" && roomRequest.outgoing)) return;
      const previous = roomRequest;
      roomRequest = { id: message.id, outgoing: false, swap: message.swap,
        crossed: !!previous && previous.swap !== message.swap };
      if (previous && !previous.cancelling && previous.swap === message.swap) {
        roomRequest.accepted = netSend({ t: "rematchAccept", id: message.id, round: roomRound });
      }
      roomNotice = "";
      updateRoomRequests();
    } else if (message.t === "rematchRevoked" && roomRole === "guest" &&
        roomRequest?.cancelling && message.id === roomRequest.id) {
      roomRequest = null;
      updateRoomRequests();
    } else if (roomRequest && message.id === roomRequest.id) {
      if (message.t === "rematchAccept" && roomRole === "host" && roomRequest.outgoing) {
        startRoomRematch(roomRequest.swap, roomRequest.id);
      } else if (message.t === "rematchRevoke") {
        if (roomRole === "host" && !roomRequest.outgoing) {
          netSend({ t: "rematchRevoked", id: roomRequest.id, round: roomRound });
        }
        roomNotice = roomRequest.outgoing ? "Your opponent declined the rematch." : "Your opponent cancelled the rematch request.";
        roomRequest = null;
        updateRoomRequests();
      }
    }
  }
}
function netSend(message) {
  if (mode !== "room" || !conn?.open) return false;
  try { conn.send(message); return true; }
  catch (error) { roomMsg(error.message || String(error)); return false; }
}
function resetPeer() {
  clearTimeout(roomTimer);
  const channel = conn, p = peer;
  conn = null;
  peer = null;
  roomReady = false;
  roomRematchPending = false;
  roomRequest = null;
  roomNotice = "";
  roomRound = 0;
  roomSeatSupport = false;
  roomRematchId = null;
  resignedSide = null;
  resignPending = false;
  if (ui.roomResignDialog?.open) ui.roomResignDialog.close();
  roomRole = null;
  mySide = 0;
  const relay = relayController;
  relayController = null;
  updateViewFlip();
  channel?.close();
  p?.destroy();
  relay?.abort();
  ui.roomCode.style.display = "none";
  ui.roomCode.classList.remove("relay-code");
  if ($("btnCopyRoom")) $("btnCopyRoom").hidden = true;
}
function randomCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// ---------------------------------------------------------------- input wiring
function cancelWallDrag(clickPoint = null) {
  if (!wallDrag) return;
  const drag = wallDrag;
  wallDrag = null;
  drag.button.classList.remove("dragging");
  $("wallDragGhost").hidden = true;
  if (drag.active) {
    if (clickPoint) {
      const pending = suppressWallClick = { button: drag.button, ...clickPoint };
      setTimeout(() => { if (suppressWallClick === pending) suppressWallClick = null; }, 500);
    }
    hover = null;
    if (canPlay() && !busy) ui.hint.textContent = boardHint();
  }
  if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
}
function updateWallDrag(event) {
  const drag = wallDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!canPlay() || busy || state !== drag.state || viewFlip !== drag.viewFlip) { cancelWallDrag(); draw(); return; }
  if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
  drag.active = true;
  drag.button.classList.add("dragging");
  hover = pick(event, drag.kind);
  const ghost = $("wallDragGhost");
  ghost.hidden = !!hover;
  ghost.dataset.orientation = drag.kind;
  ghost.style.transform = `translate(${event.clientX - (drag.kind === "H" ? 29 : 4)}px, ${event.clientY - 34 - (drag.kind === "V" ? 29 : 4)}px)`;
  if (hover) ui.hint.textContent = legalHover() ? "Release to place wall" : "Cannot place a wall here";
  else ui.hint.textContent = "Drag onto the board · release outside to cancel";
  draw();
}
ui.boardTools.addEventListener("pointerdown", (event) => {
  const button = event.target.closest('button[data-tool="H"], button[data-tool="V"]');
  if (!button || wallDrag || !event.isPrimary || event.button !== 0 || !canPlay() || busy || !state.walls[state.turn]) return;
  wallDrag = { button, pointerId: event.pointerId, kind: button.dataset.tool, state, viewFlip,
    x: event.clientX, y: event.clientY, active: false };
  try { button.setPointerCapture(event.pointerId); } catch { wallDrag = null; }
});
ui.boardTools.addEventListener("pointermove", updateWallDrag);
ui.boardTools.addEventListener("pointerup", (event) => {
  if (!wallDrag || event.pointerId !== wallDrag.pointerId) return;
  updateWallDrag(event);
  if (!wallDrag) return;
  const { active } = wallDrag;
  const action = active && hover ? actionOf(hover) : null;
  const valid = active && action !== null && canPlay() && !busy && actionsFor(state).includes(action);
  if (active) event.preventDefault();
  const invalid = active && hover && !valid;
  cancelWallDrag({ x: event.clientX, y: event.clientY });
  if (valid) { if (!applyAction(action)) afterMove(); }
  else if (invalid) status("Illegal wall", "Choose a free position that leaves both players a path.");
  else draw();
});
for (const name of ["pointercancel", "lostpointercapture"]) {
  ui.boardTools.addEventListener(name, (event) => {
    if (wallDrag?.pointerId === event.pointerId) { cancelWallDrag(); draw(); }
  });
}
window.addEventListener("blur", () => { if (wallDrag) { cancelWallDrag(); draw(); } });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && wallDrag) { cancelWallDrag(); draw(); }
});
ui.themeSwitch.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-theme]");
  if (b) setTheme(b.dataset.theme);
});
$("boardTools").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tool]");
  if (!button) return;
  const pendingClick = suppressWallClick;
  if (event.detail && pendingClick?.button === button && Math.hypot(event.clientX - pendingClick.x, event.clientY - pendingClick.y) < 3) {
    suppressWallClick = null;
    event.preventDefault();
    return;
  }
  boardTool = button.dataset.tool;
  for (const item of $("boardTools").querySelectorAll("button")) {
    item.setAttribute("aria-pressed", String(item === button));
  }
  hover = null;
  if (canPlay() && !busy) ui.hint.textContent = boardHint();
  draw();
});
cvs.addEventListener("pointermove", (e) => {
  // Touch has no hover state. Ignore compatibility mouse events generated by taps;
  // redrawing the whole canvas for them causes a visible flash on some phones.
  if ((e.pointerType !== "mouse" && e.pointerType !== "pen") || wallDrag) return;
  if (!canPlay() || busy) { if (hover) { hover = null; draw(); } return; }
  const h = pick(e);
  const same = hover && h && hover.kind === h.kind && hover.r === h.r && hover.c === h.c;
  hover = h;
  if (!same) draw();
});
cvs.addEventListener("pointerleave", () => { if (hover && !wallDrag) { hover = null; draw(); } });
cvs.addEventListener("click", (e) => {
  if (!canPlay() || busy) return;
  const h = pick(e);
  if (!h) return;
  const a = actionOf(h);
  if (a === null) return;
  if (!actionsFor(state).includes(a)) { status("Illegal move", "Choose a highlighted square or a wall that leaves both players a path."); return; }
  if (!applyAction(a)) afterMove();
});
ui.btnNew.addEventListener("click", () => {
  if (mode === "room") { if (roomReady) newGame(); return; }
  newGame();
});
for (const button of [ui.btnRoomSwap, ui.btnResultSwap]) button?.addEventListener("click", () => roomRematchClick(true));
for (const button of [ui.btnRoomSwapDecline, ui.btnResultSwapDecline]) button?.addEventListener("click", () => roomRematchClick(false, true));
ui.btnRoomResign?.addEventListener("click", () => {
  if (!canResignRoom() || !ui.roomResignDialog) return;
  ui.roomResignDialog.returnValue = "";
  ui.roomResignDialog.showModal();
});
ui.roomResignDialog?.addEventListener("close", () => {
  if (ui.roomResignDialog.returnValue === "resign") resignRoom();
});
ui.btnPlay.addEventListener("click", () => {
  if (mode !== "ai_ai" || state.terminal) return;
  running = !running;
  updateButtons();
  if (running) scheduleAi(speed * 1000);
  else { cancelAi(); render(); status(`${turnName()} to move`, "autoplay paused"); }
});
ui.btnUndo.addEventListener("click", undo);
ui.btnFlip.addEventListener("click", flipSides);
ui.btnExternalSetup.addEventListener("click", () => showExternalSetup());
ui.btnRetryAI.addEventListener("click", () => {
  if (externalMoveRunning()) {
    cancelAi();
    if (mode === "ai_ai") running = false;
    aiRetryAvailable = true;
    render();
    status(`${turnName()} to move`, "External AI move request cancelled.");
    return;
  }
  aiRetryAvailable = false;
  if (mode === "ai_ai") running = true;
  updateButtons();
  scheduleAi(0);
});
ui.btnResult.addEventListener("click", openResult);
ui.btnResultClose.addEventListener("click", closeResult);
ui.btnResultBoard.addEventListener("click", closeResult);
ui.btnResultNew.addEventListener("click", () => {
  if (mode === "room") { roomRematchClick(); return; }
  closeResult();
  newGame();
  ui.btnNew.focus({ preventScroll: true });
});
ui.btnResultUndo.addEventListener("click", () => {
  closeResult();
  undo();
  ui.btnUndo.focus({ preventScroll: true });
});
ui.btnResultReview.addEventListener("click", reviewFinishedGame);
ui.viewBottom.addEventListener("change", () => {
  viewBottomSetting = !!ui.viewBottom.checked;
  persistPrefs();
  updateViewFlip();
  render();
});
ui.speed.addEventListener("input", () => {
  speed = clamp(Number(ui.speed.value) || .7, .05, 2.5);
  ui.speedText.textContent = `${speed.toFixed(2)} s / move`;
  persistPrefs();
  if (mode === "ai_ai" && running) scheduleAi(speed * 1000);
});
ui.replaySpeed.addEventListener("change", () => {
  replaySpeed = Number(ui.replaySpeed.value);
  persistPrefs();
  if (replayPlaying) scheduleReplay();
});
ui.btnPrev.addEventListener("click", () => jumpReplay(replayIdx - 1));
ui.btnNext.addEventListener("click", () => jumpReplay(replayIdx + 1));
ui.replayPosition.addEventListener("input", () => jumpReplay(Number(ui.replayPosition.value)));
ui.btnContinue.addEventListener("click", continueReplay);
ui.btnImport.addEventListener("click", () => ui.importFile.click());
ui.importFile.addEventListener("change", importGame);
ui.btnExport.addEventListener("click", () => exportPosition());
ui.btnExportPrefix.addEventListener("click", () => exportPosition(true));
ui.btnAuto.addEventListener("click", toggleReplayAuto);
ui.btnLoad.addEventListener("click", loadSelectedSaved);
ui.btnDelete.addEventListener("click", deleteSaved);
ui.saveGames.addEventListener("change", () => { saveEnabled = !!ui.saveGames.checked; persistPrefs(); });
for (const [side, select] of [ui.engineRed, ui.engineBlue].entries()) {
  select.addEventListener("change", () => {
    if (state.turn === side) cancelAi();
    const seat = engineSeat(side);
    engineCfg[seat] = select.value;
    sigmaAgents[side] = null;
    persistPrefs();
    updatePlayers();
    updateEngineRows();
    updateExtVisibility();
    updateButtons();
    prewarmEngine();
    updateAILoading();
    if (state.terminal) { updateResult(); return; }
    const colour = side === 0 ? "Red" : "Blue";
    status(`${colour} engine: ${engineName(side)}`, parseEngine(engineCfg[seat]).kind === "ext" && !extConfigured(seat)
      ? `Configure the ${colour.toLowerCase()} endpoint in the external AI card` : "");
    if (state.turn === side) scheduleAi();
  });
}
ui.btnExtToggle.addEventListener("click", () => { extFormOpen = !extFormOpen; renderExt(); });
ui.extSeat.addEventListener("change", () => setExtSeat(Number(ui.extSeat.value)));
ui.btnExtSave.addEventListener("click", () => saveExtFromFields());
ui.btnExtForget.addEventListener("click", forgetExternalKey);
ui.btnChatClear.addEventListener("click", clearAiChat);
ui.btnClearLocal.addEventListener("click", clearLocalData);
ui.btnClearAIFiles.addEventListener("click", async () => {
  ui.btnClearAIFiles.disabled = true;
  const cleared = await clearAIAssets();
  ui.aiFilesFeedback.textContent = cleared ? "Cached AI files cleared." : "Could not clear the AI cache.";
  ui.btnClearAIFiles.disabled = false;
});
ui.btnExtTest.addEventListener("click", async () => {
  if (extTestController) { extTestController.abort(); return; }
  const profile = readExtFields();
  if (!profile) return;
  const seat = extSeat;
  const controller = extTestController = new AbortController();
  ui.extNote.textContent = "Testing endpoint...";
  ui.btnExtTest.textContent = "Cancel test";
  renderExt();
  try {
    const r = await extComplete([{ role: "user", content: "Reply with exactly: OK" }],
      { temperature: 0, maxTokens: 20, signal: controller.signal }, profile);
    if (extSeat === seat && !controller.signal.aborted) ui.extNote.textContent = `Live response: ${r.content.slice(0, 60)}`;
  } catch (err) {
    if (extSeat === seat && !controller.signal.aborted) ui.extNote.textContent = "Test failed: " + err.message;
    if (controller.signal.aborted && ui.extNote.textContent === "Testing endpoint...") ui.extNote.textContent = "Test cancelled.";
  } finally {
    extTestController = null;
    ui.btnExtTest.textContent = "Test";
    renderExt();
  }
});
ui.btnChatSend.addEventListener("click", () => {
  if (chatRequest?.seat === extSeat) { cancelChat(extSeat); renderExt(); }
  else sendChat();
});
ui.chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
for (const b of ui.seg.querySelectorAll("button")) {
  b.addEventListener("click", () => { if (b.dataset.mode !== mode) setMode(b.dataset.mode); });
}
if ($("btnDirectRoom")) {
  ui.btnCreate.addEventListener("click", () => relayRoom());
  $("btnDirectRoom").addEventListener("click", createRoom);
  $("btnCopyRoom").addEventListener("click", async () => {
    if (!roomCode || !isRelayCode(roomCode)) return;
    try {
      await navigator.clipboard.writeText(roomInvite(roomCode));
      roomMsg("Invitation link copied.");
    } catch {
      roomMsg("Copy the room code shown above.");
    }
  });
} else {
  ui.btnCreate.addEventListener("click", createRoom);
}
ui.btnJoin.addEventListener("click", joinFromInput);
ui.joinCode.addEventListener("keydown", (e) => { if (e.key === "Enter") joinFromInput(); });
window.addEventListener("resize", layout);
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey && undoIndex() >= 0) {
    e.preventDefault();
    undo();
  } else if (replayStates && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
    jumpReplay(replayIdx + (e.key === "ArrowLeft" ? -1 : 1));
  }
});

// Public API used by the desktop bridge / my own smoke tests.
window.quoridor = {
  newGame,
  move: (a) => {
    if (state.terminal || mode === "replay" || (mode === "room" && !canPlay()) || !actionsFor(state).includes(a)) return false;
    const over = applyAction(a);
    if (!over) afterMove();
    return true;
  },
  state: () => ({
    pos: [...state.pos], walls: [...state.walls], turn: state.turn, ply: state.ply,
    terminal: state.terminal, winner: state.winner, legal: state.terminal ? [] : [...actionsFor(state)], last: lastAction,
  }),
  metrics: () => lastAiMetrics ? { ...lastAiMetrics } : null,
  setMode,
  setTheme,
  get mode() { return mode; },
  get theme() { return document.documentElement.dataset.theme; },
};

function boot() {
  void pruneAIAssets();
  applyTheme();
  engineCfg[0] = fillEngineSelect(ui.engineRed, engineCfg[0]);
  engineCfg[1] = fillEngineSelect(ui.engineBlue, engineCfg[1]);
  ui.speed.value = speed;
  ui.speedText.textContent = `${speed.toFixed(2)} s / move`;
  ui.replaySpeed.value = replaySpeed;
  ui.viewBottom.checked = viewBottomSetting;
  ui.saveGames.checked = saveEnabled;
  selectedSavedId = savedGames.length ? savedGames[0].id : null;
  renderSaved();
  updateViewFlip();
  layout();
  setMode(["ai", "hotseat", "ai_ai"].includes(mode) ? mode : "ai");
  const invitation = location.hash.match(ROOM_INVITE)?.[1];
  if (invitation) {
    setMode("room");
    ui.joinCode.value = invitation;
    const url = new URL(location.href);
    url.hash = "";
    try { window.history.replaceState(null, "", url); } catch {}
  }
}
boot();
