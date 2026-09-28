const SMOOTHING = 0.1;
const WIRE_WINDOW_MS = 3000;

export class Stats {
  constructor() {
    this.reset();
  }

  reset() {
    this.fps = 0;
    this.ms = { filter: 0, bg: 0, encode: 0, render: 0 };
    this.changedPct = 0;
    this.lastTime = 0;
  }

  frame(now, timings, changedPct) {
    if (this.lastTime) {
      const instFps = 1000 / (now - this.lastTime);
      this.fps += (instFps - this.fps) * SMOOTHING;
    }
    this.lastTime = now;
    for (const k in timings) this.ms[k] += (timings[k] - this.ms[k]) * SMOOTHING;
    if (changedPct !== null) this.changedPct += (changedPct - this.changedPct) * SMOOTHING;
  }
}

// Per-mode averages
export class ModeStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.modes = {};
    this.lastMode = null;
    this.lastTime = 0;
  }

  frame(mode, now, changedPct) {
    if (mode && mode === this.lastMode) {
      const m = this.modes[mode] ??= { frames: 0, ms: 0, changedSum: 0, changedN: 0 };
      m.frames++;
      m.ms += now - this.lastTime;
      if (changedPct !== null) {
        m.changedSum += changedPct;
        m.changedN++;
      }
    }
    this.lastMode = mode;
    this.lastTime = now;
  }

  summary(mode) {
    const m = this.modes[mode];
    if (!m || !m.frames) return null;
    return {
      fps: 1000 * m.frames / m.ms,
      changedPct: m.changedN ? m.changedSum / m.changedN : 0,
      frames: m.frames,
    };
  }
}

// Wire stats
export class WireStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.events = [];
    this.since = 0;
    this.resetTotals();
  }

  resetTotals() {
    this.key = { n: 0, bytes: 0 };
    this.delta = { n: 0, bytes: 0, bitmask: 0, runs: 0, runsChosen: 0, cells: 0 };
    this.empty = 0;
    this.control = 0;
    this.cells = 0;
  }

  record(now, info, cells) {
    if (!this.since) this.since = now;
    this.cells = cells;
    const bytes = info.bytes ? info.bytes.length : 0;
    const send = info.type !== 'control';
    if (bytes || send) this.events.push({ t: now, bytes, send });
    if (info.type === 'key') {
      this.key.n++;
      this.key.bytes += bytes;
    } else if (info.type === 'delta') {
      const d = this.delta;
      d.n++;
      d.bytes += bytes;
      d.bitmask += info.bitmaskSize;
      d.runs += info.runsSize;
      d.cells += info.changed;
      if (info.format === 'runs') d.runsChosen++;
    } else if (info.type === 'empty') {
      this.empty++;
    } else if (info.type === 'control') {
      this.control += bytes;
    }
  }

  trim(now) {
    const cutoff = now - WIRE_WINDOW_MS;
    let i = 0;
    while (i < this.events.length && this.events[i].t < cutoff) i++;
    if (i) this.events.splice(0, i);
  }

  windowSeconds(now) {
    if (!this.since) return 0;
    return Math.min(WIRE_WINDOW_MS, now - this.since) / 1000;
  }

  kbps(now) {
    this.trim(now);
    const s = this.windowSeconds(now);
    if (!s) return 0;
    let bytes = 0;
    for (const e of this.events) bytes += e.bytes;
    return bytes * 8 / s / 1000;
  }

  sendFps(now) {
    this.trim(now);
    const s = this.windowSeconds(now);
    if (!s) return 0;
    let n = 0;
    for (const e of this.events) if (e.send) n++;
    return n / s;
  }
}

// Helpers
export function percentChanged(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return 100 * n / a.length;
}
