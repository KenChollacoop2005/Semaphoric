import {
  MSG_KEYFRAME, MSG_DELTA_BITMASK, MSG_DELTA_RUNS, MSG_HELLO,
  encodeKeyframe, encodeDelta, decodeHello, decodeKeyframe, deltaHeader, applyDelta,
} from './protocol.js';

export const DEFAULT_SEND_FPS = 15;
export const DEFAULT_KEYFRAME_INTERVAL_S = 5;
const SEND_SLACK_MS = 8;

// Paces frames, picks keyframe or delta
export class Sender {
  constructor() {
    this.fps = DEFAULT_SEND_FPS;
    this.keyframeIntervalS = DEFAULT_KEYFRAME_INTERVAL_S;
    this.reset();
  }

  reset() {
    this.last = null;
    this.sentMask = null;
    this.cols = 0;
    this.rows = 0;
    this.seq = 0;
    this.epoch = 0;
    this.nextSend = 0;
    this.lastKey = -Infinity;
    this.forceKey = true;
  }

  requestKeyframe() {
    this.forceKey = true;
  }

  // Packet info when a send slot is due, else null
  tick(now, grid, cols, rows) {
    // Fixed schedule; resync if we fall a slot behind
    const interval = 1000 / this.fps;
    if (now < this.nextSend - SEND_SLACK_MS) return null;
    this.nextSend += interval;
    if (this.nextSend < now - interval) this.nextSend = now + interval;

    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.epoch = (this.epoch + 1) & 0xff;
      this.last = new Uint8Array(cols * rows);
      this.sentMask = new Uint8Array(cols * rows);
      this.forceKey = true;
    }

    let info;
    if (this.forceKey || now - this.lastKey >= this.keyframeIntervalS * 1000) {
      const bytes = encodeKeyframe(this.seq, this.epoch, cols, rows, grid);
      this.sentMask.fill(1);
      this.lastKey = now;
      this.forceKey = false;
      info = { type: 'key', bytes, changed: grid.length };
    } else {
      const delta = encodeDelta(this.seq, this.epoch, this.last, grid, this.sentMask);
      // Nothing changed: send nothing, keep seq
      if (!delta) return { type: 'empty', bytes: null, changed: 0 };
      info = { type: 'delta', ...delta };
    }
    this.last.set(grid);
    this.seq = (this.seq + 1) & 0xffff;
    return info;
  }
}

// Rebuilds the grid from received messages
export class Receiver {
  constructor() {
    this.requestOnLoss = true;
    this.onKeyRequest = null;
    this.onHello = null;
    this.reset();
  }

  reset() {
    this.grid = null;
    this.cols = 0;
    this.rows = 0;
    this.epoch = -1;
    this.lastSeq = -1;
    this.glyphs = [' '];
    this.name = '';
    this.version = 0;
    this.synced = false;
    this.gaps = 0;
    this.errors = 0;
    this.frameVersion = 0;
  }

  request() {
    if (this.onKeyRequest) this.onKeyRequest();
  }

  // Malformed input: drop it, ask for a keyframe
  receive(buf) {
    try {
      this.handle(buf);
    } catch (err) {
      this.errors++;
      console.warn('decode error, requesting keyframe', err);
      this.request();
    }
  }

  handle(buf) {
    switch (buf[0]) {
      case MSG_HELLO: {
        const h = decodeHello(buf);
        this.glyphs = h.glyphs;
        this.name = h.name;
        this.version = h.version;
        if (this.onHello) this.onHello(h);
        break;
      }
      case MSG_KEYFRAME: {
        const k = decodeKeyframe(buf);
        if (k.cols !== this.cols || k.rows !== this.rows) this.grid = new Uint8Array(k.cols * k.rows);
        this.grid.set(k.grid);
        this.cols = k.cols;
        this.rows = k.rows;
        this.epoch = k.epoch;
        this.lastSeq = k.seq;
        this.synced = true;
        break;
      }
      case MSG_DELTA_BITMASK:
      case MSG_DELTA_RUNS: {
        const { seq, epoch } = deltaHeader(buf);
        // Wrong grid or no base: unusable
        if (!this.synced || epoch !== this.epoch) {
          this.request();
          return;
        }
        // Gap: apply anyway (visible glitch), maybe ask for recovery
        if (seq !== ((this.lastSeq + 1) & 0xffff)) {
          this.gaps++;
          if (this.requestOnLoss) this.request();
        }
        applyDelta(buf, this.grid);
        this.lastSeq = seq;
        break;
      }
      default:
        return;
    }
    this.frameVersion++;
  }
}

// Optionally lossy pipe to a delivery function
export class Channel {
  constructor(deliver) {
    this.deliver = deliver;
    this.lossEnabled = false;
    this.lossPct = 0;
    this.reset();
  }

  reset() {
    this.dropped = 0;
    this.delivered = 0;
  }

  // Unreliable sends may be dropped
  send(buf, reliable = false) {
    if (!reliable && this.lossEnabled && Math.random() * 100 < this.lossPct) {
      this.dropped++;
      return false;
    }
    this.delivered++;
    this.deliver(buf);
    return true;
  }
}
