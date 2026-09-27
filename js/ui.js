import { startCapture } from './capture.js';
import { cellLuminance, naiveIndices, BrailleFilter } from './filter-cpu.js';
import {
  measureGlyphAspect, parseCharset, presetCharset, fontStack, loadBrailleFont,
  DEFAULT_ASPECT_SAMPLE, BRAILLE_ASPECT_SAMPLE,
} from './glyphs.js';
import { gridToText } from './render.js';
import { Stats, ModeStats, WireStats, percentChanged } from './stats.js';
import { ManualBackground, BG_COUNTDOWN_S, BG_CAPTURE_MS } from './background.js';
import { AutoBackground } from './segment-auto.js';
import { encodeHello, encodeKeyRequest } from './protocol.js';
import { Sender, Receiver, Channel, DEFAULT_SEND_FPS, DEFAULT_KEYFRAME_INTERVAL_S } from './link.js';
import { AdaptiveController, CAP_MIN_KBPS, CAP_MAX_KBPS, CAP_DEFAULT_KBPS } from './adaptive.js';
import { WireView } from './wireview.js';
import { Call, GRAPH_WINDOW_S } from './call.js';
import { Screens, copyText } from './screens.js';
import { generateRoomCode, normalizeRoomCode, ROOM_CODE_PATTERN } from './roomcode.js';
import { drawNetGraph } from './netgraph.js';

const DEFAULT_CELL_SIZE = 5;
const DEFAULT_FONT = 'Consolas';
const DEFAULT_PRESET = 'standard';
const DEFAULT_LOSS_PCT = 10;
const DIALUP_KBPS = 56;
const REFERENCE_WIDTH = 1280;
const REFERENCE_HEIGHT = 720;
const STATS_INTERVAL_MS = 250;
const STATS_OPEN_KEY = 'semaphoric.statsOpen';
const NAME_KEY = 'semaphoric.name';
const NAME_MAX = 16;
const BG_GLYPH_INDEX = 0;
const BG_MODES = ['off', 'auto', 'manual'];
const PIP_FRACTION = 0.28;
const LOST_RETURN_MS = 3000;
const BRAILLE_FIRST = 0x2800;
const BRAILLE_LAST = 0x28ff;
const NO_ROUTE_HINT = 'SOME NETWORKS BLOCK DIRECT BROWSER-TO-BROWSER CONNECTIONS.';
const STATUS_LABELS = {
  solo: 'SOLO', hosting: 'HOSTING', connecting: 'CONNECTING', linked: 'LINKED', lost: 'LOST', failed: 'FAILED',
};

const el = (id) => document.getElementById(id);
const ui = {
  stage: el('stage'),
  views: el('views'),
  ascii: el('ascii'),
  asciiRemote: el('asciiRemote'),
  localTag: el('localTag'),
  remoteTag: el('remoteTag'),
  wireHeat: el('wireHeat'),
  wireBytes: el('wireBytes'),
  source: el('source'),
  remoteVideo: el('remoteVideo'),
  stats: el('stats'),
  statsBox: el('statsBox'),
  statsToggle: el('statsToggle'),
  overlay: el('overlay'),
  menu: el('menu'),
  menuMsg: el('menuMsg'),
  callCard: el('callCard'),
  stop: el('stop'),
  cellSize: el('cellSize'),
  cellSizeOut: el('cellSizeOut'),
  font: el('font'),
  charsetPreset: el('charsetPreset'),
  charset: el('charset'),
  showSource: el('showSource'),
  bgMode: el('bgMode'),
  bgManual: el('bgManual'),
  bgCapture: el('bgCapture'),
  bgRecapture: el('bgRecapture'),
  bgStatus: el('bgStatus'),
  connection: el('connection'),
  connStatus: el('connStatus'),
  connMode: el('connMode'),
  connCodeRow: el('connCodeRow'),
  connCode: el('connCode'),
  connCopy: el('connCopy'),
  connPeer: el('connPeer'),
  connCounter: el('connCounter'),
  connGraph: el('connGraph'),
  compareVideo: el('compareVideo'),
  layoutPip: el('layoutPip'),
  layoutSide: el('layoutSide'),
  disconnect: el('disconnect'),
  showRemote: el('showRemote'),
  capOn: el('capOn'),
  capKbps: el('capKbps'),
  capKbpsOut: el('capKbpsOut'),
  capStatus: el('capStatus'),
  lossOn: el('lossOn'),
  lossPct: el('lossPct'),
  lossPctOut: el('lossPctOut'),
  lossRequest: el('lossRequest'),
  wireOn: el('wireOn'),
};

const state = {
  cellSize: DEFAULT_CELL_SIZE,
  userCellSize: DEFAULT_CELL_SIZE,
  font: DEFAULT_FONT,
  preset: DEFAULT_PRESET,
  renderMode: 'ramp',
  glyphs: parseCharset(presetCharset(DEFAULT_PRESET)),
  aspect: 0.5,
  remoteAspect: 0,
  cols: 0,
  rows: 0,
  cellLum: null,
  indices: null,
  prevIndices: null,
  fg: null,
  hasPrev: false,
  bgMode: 'off',
  bgPhase: 'idle',
  phaseEnd: 0,
  autoStatus: '',
  split: false,
  splitByLoss: false,
  statsOpen: loadStatsOpen(),
  capOn: false,
  wireOn: false,
  sentGlyphs: null,
  helloKey: null,
  remoteVersion: -1,
  remoteDims: '',
  lastPacket: null,
  keyRequests: 0,
  layout: 'pip',
  lastAttempt: null,
};

const stats = new Stats();
const modeStats = new ModeStats();
const wire = new WireStats();
const manual = new ManualBackground();
const auto = new AutoBackground();
const braille = new BrailleFilter();
const sender = new Sender();
const loopReceiver = new Receiver();
const loopChannel = new Channel((buf) => loopReceiver.receive(buf));
const call = new Call();
const callChannel = new Channel((buf) => call.send(buf));
const adaptive = new AdaptiveController((cell) => {
  const g = gridFor(cell);
  return g.cols * g.rows;
});
const wireView = new WireView(ui.wireHeat, ui.wireBytes);
const screens = new Screens({ menu: ui.menu, menuMsg: ui.menuMsg, card: ui.callCard });
let cap = null;
let frameHandle = 0;
let lastStatsUpdate = 0;

// Any receiver asking for recovery lands here
function onKeyRequest() {
  state.keyRequests++;
  sender.requestKeyframe();
}

loopReceiver.onKeyRequest = () => {
  wire.record(performance.now(), { type: 'control', bytes: encodeKeyRequest() }, 0);
  onKeyRequest();
};

const activeChannel = () => (call.linked ? callChannel : loopChannel);

// Grid dims for a cell size at current aspect
function gridFor(cellSize) {
  const width = cap ? cap.width : REFERENCE_WIDTH;
  const height = cap ? cap.height : REFERENCE_HEIGHT;
  return {
    cols: Math.max(1, Math.floor(width / cellSize)),
    rows: Math.max(1, Math.floor(height / (cellSize / state.aspect))),
  };
}

function aspectSample() {
  return state.renderMode === 'braille' ? BRAILLE_ASPECT_SAMPLE : DEFAULT_ASPECT_SAMPLE;
}

function rebuildGrid() {
  state.aspect = measureGlyphAspect(state.font, aspectSample());
  if (!cap) return;
  const { cols, rows } = gridFor(state.cellSize);
  const oldCols = state.cols;
  const oldRows = state.rows;
  const gridChanged = cols !== oldCols || rows !== oldRows;
  state.cols = cols;
  state.rows = rows;
  const n = cols * rows;
  state.cellLum = new Float32Array(n);
  state.indices = new Uint8Array(n);
  state.prevIndices = new Uint8Array(n);
  state.fg = new Uint8Array(n);
  state.hasPrev = false;
  cap.setGrid(cols, rows);
  wireView.resize(cols, rows);
  stats.reset();
  modeStats.reset();
  wire.resetTotals();
  // Keep background model across resizes
  if (gridChanged) {
    if (state.bgPhase !== 'idle') {
      manual.reset();
      setPhase('idle');
    } else if (oldCols) {
      manual.resize(oldCols, oldRows, cols, rows);
    }
  }
  updateBgUi();
  fitFont();
}

const fitSize = (cols, rows, aspect, w, h) => `${Math.floor(Math.min(w / (cols * aspect), h / rows) * 100) / 100}px`;

// Scale fonts so each grid fits its pane
function fitFont() {
  const stack = fontStack(state.font);
  ui.ascii.style.fontFamily = stack;
  ui.asciiRemote.style.fontFamily = stack;
  if (!state.cols) return;
  const cs = getComputedStyle(ui.stage);
  const innerW = ui.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const innerH = ui.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const gap = parseFloat(getComputedStyle(ui.views).columnGap) || 0;

  if (call.linked) {
    const r = call.receiver;
    const rc = r.cols || state.cols;
    const rr = r.rows || state.rows;
    const ra = state.remoteAspect || state.aspect;
    if (state.layout === 'pip') {
      ui.asciiRemote.style.fontSize = fitSize(rc, rr, ra, innerW, innerH);
      ui.ascii.style.fontSize = fitSize(state.cols, state.rows, state.aspect, innerW * PIP_FRACTION, innerH * PIP_FRACTION);
    } else {
      const half = (innerW - gap) / 2;
      ui.asciiRemote.style.fontSize = fitSize(rc, rr, ra, half, innerH);
      ui.ascii.style.fontSize = fitSize(state.cols, state.rows, state.aspect, half, innerH);
    }
    return;
  }

  const panes = state.split ? 2 : 1;
  const paneW = (innerW - gap * (panes - 1)) / panes;
  const size = fitSize(state.cols, state.rows, state.aspect, paneW, innerH);
  ui.ascii.style.fontSize = size;
  ui.asciiRemote.style.fontSize = size;
}

// Stage classes and tags for solo, split or call
function applyStage() {
  const linked = call.linked;
  ui.stage.classList.toggle('call', linked);
  ui.stage.classList.toggle('pip', linked && state.layout === 'pip');
  ui.stage.classList.toggle('side', linked && state.layout === 'side');
  ui.stage.classList.toggle('split', !linked && state.split);
  ui.localTag.textContent = linked ? (call.name || 'YOU') : 'LOCAL';
  ui.remoteTag.textContent = linked ? (call.peerName || 'PEER') : 'RECEIVED';
  ui.showRemote.disabled = linked;
  state.remoteVersion = -1;
  fitFont();
}

function setPhase(phase, durationMs = 0) {
  state.bgPhase = phase;
  state.phaseEnd = performance.now() + durationMs;
  ui.overlay.hidden = phase === 'idle';
  updateBgUi();
}

// Countdown, then accumulate background samples
function stepBackgroundCapture(now) {
  if (state.bgPhase === 'countdown') {
    const left = Math.ceil((state.phaseEnd - now) / 1000);
    if (left > 0) {
      ui.overlay.textContent = `LEAVE FRAME\n${left}`;
      return;
    }
    manual.begin(state.cols * state.rows);
    setPhase('capturing', BG_CAPTURE_MS);
  }
  if (state.bgPhase === 'capturing') {
    ui.overlay.textContent = 'CAPTURING BACKGROUND';
    manual.addSample(state.cellLum);
    if (now >= state.phaseEnd) {
      manual.finish();
      setPhase('idle');
    }
  }
}

// Blank background cells; returns measured mode or null
function applyBackground() {
  const mode = state.bgMode;
  if (mode === 'off') return 'off';
  if (mode === 'auto') {
    if (!auto.ready) return null;
    auto.classify(cap.video, state.cols, state.rows, state.fg);
  } else {
    if (!manual.ready || state.bgPhase !== 'idle') return null;
    manual.classify(state.cellLum, state.cols, state.rows, state.fg);
  }
  const { indices, fg } = state;
  for (let i = 0; i < indices.length; i++) if (!fg[i]) indices[i] = BG_GLYPH_INDEX;
  return mode;
}

// Encode; route to peer when linked, else loopback
function sendFrame(now) {
  const linked = call.linked;
  // Hidden tab: keep the link, stop sending
  if (linked && document.hidden) return;
  const ch = activeChannel();
  const helloKey = `${linked}|${state.cols}x${state.rows}`;
  if (state.glyphs !== state.sentGlyphs || helloKey !== state.helloKey) {
    const bytes = encodeHello(linked ? call.name : '', state.cols, state.rows, state.glyphs);
    ch.send(bytes, true);
    wire.record(now, { type: 'control', bytes }, 0);
    sender.requestKeyframe();
    state.sentGlyphs = state.glyphs;
    state.helloKey = helloKey;
  }
  const info = sender.tick(now, state.indices, state.cols, state.rows);
  if (!info) return;
  if (info.bytes) {
    ch.send(info.bytes);
    state.lastPacket = { info, seq: (sender.seq - 1) & 0xffff };
  }
  wire.record(now, info, state.cols * state.rows);
  if (info.type !== 'key') adaptive.observe(info.bytes ? info.bytes.length : 0, state.cols * state.rows);
  if (state.wireOn) wireView.update(sender.sentMask, info.type === 'key');
}

function renderViews() {
  ui.ascii.textContent = gridToText(state.indices, state.cols, state.rows, state.glyphs);
  const linked = call.linked;
  if (!linked && !state.split) return;
  const r = linked ? call.receiver : loopReceiver;
  if (r.frameVersion === state.remoteVersion) return;
  state.remoteVersion = r.frameVersion;
  if (!r.grid) {
    ui.asciiRemote.textContent = linked ? 'WAITING FOR PICTURE...' : '';
    return;
  }
  ui.asciiRemote.textContent = gridToText(r.grid, r.cols, r.rows, r.glyphs);
  const dims = `${r.cols}x${r.rows}`;
  if (dims !== state.remoteDims) {
    state.remoteDims = dims;
    fitFont();
  }
}

function processFrame() {
  const t0 = performance.now();
  const luma = cap.grab();
  cellLuminance(luma, cap.sampleWidth, cap.sampleHeight, state.cols, state.rows, state.cellLum);
  if (state.renderMode === 'braille') {
    braille.run(luma, cap.sampleWidth, state.cols, state.rows, state.indices);
  } else {
    naiveIndices(state.cellLum, state.glyphs.length, state.indices);
  }
  const t1 = performance.now();

  stepBackgroundCapture(t1);
  const measuredMode = applyBackground();
  const t2 = performance.now();

  sendFrame(t2);
  const t3 = performance.now();

  renderViews();
  const t4 = performance.now();

  const changed = state.hasPrev ? percentChanged(state.indices, state.prevIndices) : null;
  // Swap current and previous buffers
  [state.prevIndices, state.indices] = [state.indices, state.prevIndices];
  state.hasPrev = true;

  stats.frame(t4, { filter: t1 - t0, bg: t2 - t1, encode: t3 - t2, render: t4 - t3 }, changed);
  modeStats.frame(measuredMode, t4, changed);
  if (t4 - lastStatsUpdate > STATS_INTERVAL_MS) {
    lastStatsUpdate = t4;
    if (state.statsOpen) showStats(t4);
    updateCapUi(t4);
    if (state.wireOn && state.lastPacket) wireView.showPacket(state.lastPacket.info, state.lastPacket.seq);
  }
  // Last: may rebuild the grid
  if (state.capOn && adaptive.update(t4, wire.kbps(t4))) applyCapLevel();
}

function loadStatsOpen() {
  try {
    return localStorage.getItem(STATS_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

// Collapse to just the header button
function setStatsOpen(open) {
  state.statsOpen = open;
  ui.stats.hidden = !open;
  ui.statsToggle.textContent = open ? 'STATS [-]' : 'STATS [+]';
  ui.statsToggle.setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem(STATS_OPEN_KEY, open ? '1' : '0');
  } catch {}
  if (open && cap) showStats(performance.now());
}

const avg = (sum, n) => (n ? Math.round(sum / n) : '--');

function showStats(now) {
  const ms = stats.ms;
  const cells = state.cols * state.rows;
  const k = wire.key;
  const d = wire.delta;
  const frames = k.n + d.n + wire.empty;
  const lines = [
    `mode     ${state.renderMode === 'braille' ? 'braille' : 'naive'} / bg ${state.bgMode}`,
    `fps      ${stats.fps.toFixed(1)}`,
    `filter   ${ms.filter.toFixed(2)} ms`,
    `bg       ${ms.bg.toFixed(2)} ms`,
    `encode   ${ms.encode.toFixed(2)} ms`,
    `render   ${ms.render.toFixed(2)} ms`,
    `grid     ${state.cols}×${state.rows} (${cells} cells)`,
    `sample   ${cap.sampleWidth}×${cap.sampleHeight} px`,
    `changed  ${stats.changedPct.toFixed(1)}%`,
  ];
  if (state.bgMode === 'manual' && manual.ready) lines.push(`gain     ${manual.gain.toFixed(3)}×`);
  lines.push(
    ``,
    `send     ${wire.sendFps(now).toFixed(1)} fps  ${wire.kbps(now).toFixed(1)} kbps payload${call.linked ? ' to peer' : ''}`,
    `frame    ${avg(k.bytes + d.bytes, frames)} B avg`,
    `key      ${avg(k.bytes, k.n)} B avg (${k.n})`,
    `delta    ${avg(d.bytes, d.n)} B avg (${d.n}, ${wire.empty} empty)`,
    `format   bitmask ${avg(d.bitmask, d.n)} B / runs ${avg(d.runs, d.n)} B, runs won ${d.n ? Math.round(100 * d.runsChosen / d.n) : '--'}%`,
    `sent     ${d.n ? (100 * d.cells / d.n / cells).toFixed(1) : '--'}% cells per delta`,
  );
  const ch = activeChannel();
  if (ch.lossEnabled) {
    const gaps = call.linked ? '' : `  gaps ${loopReceiver.gaps}`;
    lines.push(`loss     ${ch.lossPct}%  dropped ${ch.dropped}${gaps}  key req ${state.keyRequests}`);
  }
  if (state.capOn) {
    const L = adaptive.settings;
    lines.push(`cap      L${adaptive.level + 1} cell ${L.cell} ${L.fps}fps key ${L.kf}s, predicted ${adaptive.predictKbps(adaptive.level).toFixed(1)} / ${adaptive.budgetKbps} kbps`);
  }
  lines.push(``, `bg avg   fps    changed  frames`);
  for (const mode of BG_MODES) {
    const s = modeStats.summary(mode);
    lines.push(s
      ? `${mode.padEnd(8)} ${s.fps.toFixed(1).padStart(5)}  ${(s.changedPct.toFixed(1) + '%').padStart(7)}  ${s.frames}`
      : `${mode.padEnd(8)}     --       --`);
  }
  ui.stats.textContent = lines.join('\n');
}

function updateBgUi() {
  const isManual = state.bgMode === 'manual';
  const busy = state.bgPhase !== 'idle';
  ui.bgManual.hidden = !isManual;
  ui.bgCapture.hidden = manual.ready;
  ui.bgRecapture.hidden = !manual.ready;
  ui.bgCapture.disabled = !cap || busy;
  ui.bgRecapture.disabled = !cap || busy;

  let text = '';
  if (state.bgMode === 'auto') {
    text = state.autoStatus;
  } else if (isManual) {
    text = busy ? 'CAPTURING...' : manual.ready ? 'BACKGROUND STORED' : 'NO BACKGROUND';
  }
  ui.bgStatus.textContent = text;
}

function captureBackground() {
  if (!cap) return;
  setPhase('countdown', BG_COUNTDOWN_S * 1000);
}

async function setBgMode(mode) {
  state.bgMode = mode;
  if (mode !== 'manual' && state.bgPhase !== 'idle') setPhase('idle');
  if (mode === 'auto' && !auto.ready) {
    state.autoStatus = 'LOADING MODEL...';
    updateBgUi();
    try {
      await auto.load();
      state.autoStatus = `MODEL READY (${auto.delegate})`;
    } catch (err) {
      console.error(err);
      state.autoStatus = `MODEL FAILED: ${err.message}`;
    }
  }
  updateBgUi();
}

function setCellSize(v) {
  ui.cellSize.value = v;
  ui.cellSizeOut.value = v;
  if (state.cellSize === v) return;
  state.cellSize = v;
  rebuildGrid();
}

// Charset preset fills the editable box
async function selectPreset(name) {
  state.preset = name;
  const mode = name === 'braille' ? 'braille' : 'ramp';
  // Measure aspect only once braille font is in
  if (mode === 'braille') {
    try {
      await loadBrailleFont();
    } catch (err) {
      console.warn('braille font failed to load; widths may be uneven', err);
    }
    if (state.preset !== name) return;
  }
  ui.charset.value = presetCharset(name, state.font);
  ui.charset.readOnly = mode === 'braille';
  state.glyphs = parseCharset(ui.charset.value);
  if (mode !== state.renderMode) {
    state.renderMode = mode;
    braille.reset();
    rebuildGrid();
  }
}

function setSplit(on) {
  state.split = on;
  ui.showRemote.checked = on;
  applyStage();
}

// Undo on untick: close view we opened, resync receiver
function setLossEnabled(on) {
  loopChannel.lossEnabled = on;
  callChannel.lossEnabled = on;
  if (on) {
    if (!state.split && !call.linked) {
      state.splitByLoss = true;
      setSplit(true);
    }
    return;
  }
  if (state.splitByLoss) {
    state.splitByLoss = false;
    setSplit(false);
  }
  sender.requestKeyframe();
}

function applyCapLevel() {
  const L = adaptive.settings;
  sender.fps = L.fps;
  sender.keyframeIntervalS = L.kf;
  setCellSize(L.cell);
  updateCapUi(performance.now());
}

function setCapEnabled(on) {
  state.capOn = on;
  ui.cellSize.disabled = on;
  if (on) {
    state.userCellSize = state.cellSize;
    adaptive.start(performance.now());
    applyCapLevel();
  } else {
    sender.fps = DEFAULT_SEND_FPS;
    sender.keyframeIntervalS = DEFAULT_KEYFRAME_INTERVAL_S;
    setCellSize(state.userCellSize);
  }
  updateCapUi(performance.now());
}

function updateCapUi(now) {
  const budget = adaptive.budgetKbps;
  ui.capKbpsOut.value = budget === DIALUP_KBPS ? `${budget} DIAL-UP` : `${budget}`;
  if (!state.capOn) {
    ui.capStatus.textContent = `OFF: ${sender.fps} FPS, KEY EVERY ${sender.keyframeIntervalS}S`;
    return;
  }
  const L = adaptive.settings;
  const measured = cap ? wire.kbps(now).toFixed(1) : '--';
  ui.capStatus.textContent =
    `LEVEL ${adaptive.level + 1}/${adaptive.levelCount}: CELL ${L.cell}, ${L.fps} FPS, KEY ${L.kf}S\n` +
    `PREDICTED ${adaptive.predictKbps(adaptive.level).toFixed(1)} KBPS\n` +
    `MEASURED ${measured} / ${budget} KBPS`;
}

function setWireView(on) {
  state.wireOn = on;
  ui.wireHeat.hidden = !on;
  ui.wireBytes.hidden = !on;
  if (!on) wireView.clear();
}

// Run once per new camera frame
function loop() {
  if (!cap) return;
  processFrame();
  frameHandle = cap.video.requestVideoFrameCallback(loop);
}

// Throws if the camera can't start
async function startCamera() {
  if (cap) return;
  cap = await startCapture(ui.source);
  ui.statsBox.hidden = false;
  ui.stop.disabled = false;
  rebuildGrid();
  if (state.capOn) {
    adaptive.start(performance.now());
    applyCapLevel();
  }
  frameHandle = cap.video.requestVideoFrameCallback(loop);
}

// Release camera; background model is session-bound
function stop() {
  if (call.active) call.disconnect();
  if (!cap) return;
  cap.video.cancelVideoFrameCallback(frameHandle);
  cap.stream.getTracks().forEach((t) => t.stop());
  cap.video.srcObject = null;
  cap = null;
  manual.reset();
  braille.reset();
  sender.reset();
  loopReceiver.reset();
  loopChannel.reset();
  callChannel.reset();
  wire.reset();
  wireView.clear();
  state.sentGlyphs = null;
  state.helloKey = null;
  state.lastPacket = null;
  state.remoteVersion = -1;
  setPhase('idle');
  state.cols = 0;
  state.rows = 0;
  ui.ascii.textContent = '';
  ui.asciiRemote.textContent = '';
  ui.stats.textContent = '';
  ui.statsBox.hidden = true;
  ui.stop.disabled = true;
  updateBgUi();
  screens.showMenu();
}

// --- Start menu and call flows ---

function loadName() {
  try {
    return sessionStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

async function askName() {
  const name = await screens.prompt('DISPLAY NAME:', { value: loadName(), maxLength: NAME_MAX });
  if (name === null) return null;
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {}
  return name;
}

function cameraErrorText(err) {
  if (err.name === 'NotAllowedError') return 'CAMERA PERMISSION DENIED. ALLOW IT AND TRY AGAIN.';
  if (err.name === 'NotFoundError') return 'NO CAMERA FOUND.';
  return `CAMERA ERROR: ${err.message}`;
}

async function ensureCamera() {
  if (cap) return true;
  screens.showNotice('STARTING CAMERA...');
  try {
    await startCamera();
    return true;
  } catch (err) {
    screens.showMenu(cameraErrorText(err));
    return false;
  }
}

const roomLink = (code) => `${location.origin}${location.pathname}#${code}`;

function leaveCall() {
  call.disconnect();
  screens.showMenu();
}

async function soloFlow() {
  if (await ensureCamera()) {
    screens.clearCard();
    screens.hideMenu();
  }
}

async function hostFlow(knownName = null) {
  const name = knownName ?? await askName();
  if (name === null) return screens.showMenu();
  if (!await ensureCamera()) return;
  const code = generateRoomCode();
  state.lastAttempt = { kind: 'host', name };
  screens.showHosting(code, roomLink(code), leaveCall);
  try {
    await call.host(name, code);
  } catch (err) {
    console.error(err);
    showCallFailure(`SIGNALING FAILED: ${err.message}`);
  }
}

const validateCode = (v) => (ROOM_CODE_PATTERN.test(normalizeRoomCode(v)) ? null : 'FORMAT: word-word-1234');

async function joinFlow(prefill = '', knownName = null) {
  const name = knownName ?? await askName();
  if (name === null) return screens.showMenu();
  let code = prefill;
  if (!code) {
    code = await screens.prompt('ROOM CODE:', { maxLength: 40, validate: validateCode });
    if (code === null) return screens.showMenu();
  }
  code = normalizeRoomCode(code);
  if (!await ensureCamera()) return;
  state.lastAttempt = { kind: 'join', name, code };
  screens.showConnecting(code, leaveCall);
  try {
    await call.join(name, code);
  } catch (err) {
    console.error(err);
    showCallFailure(`SIGNALING FAILED: ${err.message}`);
  }
}

async function manualFlow(knownName = null) {
  const name = knownName ?? await askName();
  if (name === null) return screens.showMenu();
  if (!await ensureCamera()) return;
  state.lastAttempt = { kind: 'manual', name };
  screens.showManual({
    createOffer: () => call.manualOffer(name),
    acceptAnswer: (code) => call.manualAnswer(code),
    acceptOffer: (code) => call.manualAccept(name, code),
    onBack: leaveCall,
  });
}

function retryLast() {
  const a = state.lastAttempt;
  if (!a) return screens.showMenu();
  if (a.kind === 'host') return hostFlow(a.name);
  if (a.kind === 'join') return joinFlow(a.code, a.name);
  return manualFlow(a.name);
}

function showCallFailure(reason) {
  const name = state.lastAttempt?.name ?? null;
  const full = reason === 'ROOM FULL';
  screens.showFailure(reason, full ? 'THIS ROOM ALREADY HAS TWO PEOPLE IN IT.' : NO_ROUTE_HINT, [
    { label: 'RETRY', fn: () => { call.disconnect(); retryLast(); } },
    { label: 'TRY MANUAL CONNECT', fn: () => { call.disconnect(); manualFlow(name); } },
    { label: 'BACK', fn: leaveCall },
  ]);
}

async function onCallStatus(status, detail) {
  applyStage();
  updateConnUi();
  if (status === 'linked') {
    state.helloKey = null;
    state.keyRequests = 0;
    callChannel.reset();
    state.remoteDims = '';
    sender.requestKeyframe();
    await screens.showEstablished();
    if (call.linked) fitFont();
  } else if (status === 'lost') {
    stopRemoteVideo();
    screens.showNotice(detail || 'PEER DISCONNECTED');
    setTimeout(() => {
      if (call.status !== 'lost') return;
      if (call.mode === 'room' && call.role === 'host') {
        call.resumeHosting();
        screens.showHosting(call.code, roomLink(call.code), leaveCall);
      } else {
        call.disconnect();
        screens.showMenu(detail || 'PEER DISCONNECTED');
      }
    }, LOST_RETURN_MS);
  } else if (status === 'failed') {
    showCallFailure(detail);
  } else if (status === 'solo') {
    stopRemoteVideo();
  }
}

// Remote peer's grid may use a different glyph width
async function onRemoteHello(h) {
  const sample = h.glyphs[h.glyphs.length - 1] || DEFAULT_ASPECT_SAMPLE;
  const code = sample.codePointAt(0);
  if (code >= BRAILLE_FIRST && code <= BRAILLE_LAST) {
    try {
      await loadBrailleFont();
    } catch {}
  }
  state.remoteAspect = measureGlyphAspect(state.font, sample);
  applyStage();
  updateConnUi();
}

function stopRemoteVideo() {
  ui.remoteVideo.srcObject = null;
  ui.compareVideo.checked = false;
}

const kbpsText = (v) => v.toFixed(1).padStart(7);

function counterText() {
  const n = call.net;
  const k = wire.key;
  const d = wire.delta;
  const ascii = n.hasDcStats ? n.dcSent : n.paySent;
  const lines = [
    'ASCII, DATA CHANNEL (INCL. FRAMING)',
    n.hasDcStats ? `  SENT ${kbpsText(n.dcSent)}  RECV ${kbpsText(n.dcRecv)} KBPS` : '  NOT REPORTED BY THIS BROWSER',
    'ASCII, APP PAYLOAD',
    `  SENT ${kbpsText(n.paySent)}  RECV ${kbpsText(n.payRecv)} KBPS`,
    `  AVG KEY ${avg(k.bytes, k.n)} B, DELTA ${avg(d.bytes, d.n)} B`,
    `  CHANGED ${stats.changedPct.toFixed(1)}% OF CELLS / FRAME`,
  ];
  if (call.comparing || n.videoSent > 0) {
    lines.push('REAL VIDEO, RTP');
    lines.push(`  SENT ${kbpsText(n.videoSent)}  RECV ${kbpsText(n.videoRecv)} KBPS`);
    if (ascii > 0 && n.videoSent > 0) lines.push(`ASCII IS 1/${Math.round(n.videoSent / ascii)} OF VIDEO`);
  }
  return lines.join('\n');
}

function updateConnUi() {
  const active = call.active;
  ui.connection.hidden = !active;
  if (!active) return;
  ui.connStatus.textContent = STATUS_LABELS[call.status] ?? call.status.toUpperCase();
  ui.connMode.textContent = call.mode === 'manual' ? 'MANUAL' : 'ROOM';
  ui.connCodeRow.hidden = call.mode !== 'room';
  ui.connCode.textContent = call.code ?? '';
  ui.connPeer.textContent = call.peerName || '--';
  ui.compareVideo.disabled = !call.linked;
  ui.compareVideo.checked = call.comparing;
  ui.layoutPip.classList.toggle('active', state.layout === 'pip');
  ui.layoutSide.classList.toggle('active', state.layout === 'side');
  ui.connCounter.textContent = call.linked ? counterText() : '';
  ui.connGraph.hidden = !call.linked;
  if (call.linked) drawNetGraph(ui.connGraph, call.history, GRAPH_WINDOW_S);
}

function setLayout(layout) {
  state.layout = layout;
  applyStage();
  updateConnUi();
}

function bindCall() {
  call.on('status', onCallStatus);
  call.on('hello', onRemoteHello);
  call.on('keyrequest', onKeyRequest);
  call.on('netstats', updateConnUi);
  call.on('remotetrack', (track, stream) => {
    ui.remoteVideo.srcObject = stream;
    ui.remoteVideo.play().catch(() => {});
  });
  screens.onMenuSelect = (item) => {
    if (item === 'start') soloFlow();
    else if (item === 'host') hostFlow();
    else if (item === 'join') joinFlow();
    else if (item === 'manual') manualFlow();
  };
  ui.connCopy.addEventListener('click', () => copyText(roomLink(call.code), ui.connCopy));
  ui.compareVideo.addEventListener('change', () => {
    if (!cap || !call.linked) {
      ui.compareVideo.checked = false;
      return;
    }
    call.setCompare(ui.compareVideo.checked, cap.track, cap.stream);
    updateConnUi();
  });
  ui.layoutPip.addEventListener('click', () => setLayout('pip'));
  ui.layoutSide.addEventListener('click', () => setLayout('side'));
  ui.disconnect.addEventListener('click', leaveCall);
  // Fresh keyframe when the tab comes back
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && call.linked) sender.requestKeyframe();
  });
  window.addEventListener('pagehide', () => {
    if (call.active) call.disconnect();
  });
}

function bindControls() {
  ui.cellSize.value = state.cellSize;
  ui.cellSizeOut.value = state.cellSize;
  ui.font.value = state.font;
  ui.charsetPreset.value = state.preset;
  ui.charset.value = state.glyphs.join('');
  ui.bgMode.value = state.bgMode;
  ui.capKbps.min = CAP_MIN_KBPS;
  ui.capKbps.max = CAP_MAX_KBPS;
  ui.capKbps.value = CAP_DEFAULT_KBPS;
  ui.lossPct.value = DEFAULT_LOSS_PCT;
  ui.lossPctOut.value = `${DEFAULT_LOSS_PCT}%`;
  loopChannel.lossPct = DEFAULT_LOSS_PCT;
  callChannel.lossPct = DEFAULT_LOSS_PCT;
  ui.lossRequest.checked = loopReceiver.requestOnLoss;

  ui.stop.addEventListener('click', stop);
  ui.cellSize.addEventListener('input', () => setCellSize(Number(ui.cellSize.value)));
  ui.font.addEventListener('change', () => {
    state.font = ui.font.value;
    rebuildGrid();
  });
  ui.charsetPreset.addEventListener('change', () => selectPreset(ui.charsetPreset.value));
  ui.charset.addEventListener('input', () => {
    if (ui.charset.readOnly) return;
    const glyphs = parseCharset(ui.charset.value);
    if (glyphs.length >= 1) state.glyphs = glyphs;
  });
  ui.showSource.addEventListener('change', () => {
    ui.source.hidden = !ui.showSource.checked;
  });
  ui.bgMode.addEventListener('change', () => setBgMode(ui.bgMode.value));
  ui.bgCapture.addEventListener('click', captureBackground);
  ui.bgRecapture.addEventListener('click', captureBackground);

  ui.showRemote.addEventListener('change', () => {
    state.splitByLoss = false;
    setSplit(ui.showRemote.checked);
  });
  ui.capOn.addEventListener('change', () => setCapEnabled(ui.capOn.checked));
  ui.capKbps.addEventListener('input', () => {
    const now = performance.now();
    if (adaptive.setBudget(Number(ui.capKbps.value), now) && state.capOn) applyCapLevel();
    updateCapUi(now);
  });
  ui.lossOn.addEventListener('change', () => setLossEnabled(ui.lossOn.checked));
  ui.lossPct.addEventListener('input', () => {
    loopChannel.lossPct = Number(ui.lossPct.value);
    callChannel.lossPct = loopChannel.lossPct;
    ui.lossPctOut.value = `${loopChannel.lossPct}%`;
  });
  ui.lossRequest.addEventListener('change', () => {
    loopReceiver.requestOnLoss = ui.lossRequest.checked;
    call.receiver.requestOnLoss = ui.lossRequest.checked;
  });
  ui.wireOn.addEventListener('change', () => setWireView(ui.wireOn.checked));
  ui.statsToggle.addEventListener('click', () => setStatsOpen(!state.statsOpen));
  setStatsOpen(state.statsOpen);

  new ResizeObserver(fitFont).observe(ui.stage);
  updateBgUi();
  updateCapUi(performance.now());
}

bindControls();
bindCall();

// Link with #word-word-1234 goes straight to join
const hashCode = normalizeRoomCode(location.hash);
if (ROOM_CODE_PATTERN.test(hashCode)) joinFlow(hashCode);
else screens.showMenu();
