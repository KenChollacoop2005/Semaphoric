import { KEY_HEADER_BYTES } from './protocol.js';

export const CAP_MIN_KBPS = 8;
export const CAP_MAX_KBPS = 256;
export const CAP_DEFAULT_KBPS = 56;
const CAP_KEYFRAME_SHARE = 0.5;
const CAP_UP_FILL = 0.8;
const CAP_DOWN_FILL = 0.95;
const CAP_SETTLE_MS = 3000;
const CAP_UPGRADE_HOLD_MS = 3000;
const CAP_OVERSHOOT_GUARD = 1.25;
const CAP_PRIOR_BYTES_PER_CELL = 0.15;
const CAP_COST_SMOOTHING = 0.05;

// Quality ladder
const CAP_LADDER = [
  { cell: 5, fps: 15, kf: 3 },
  { cell: 6, fps: 15, kf: 4 },
  { cell: 8, fps: 12, kf: 5 },
  { cell: 10, fps: 10, kf: 6 },
  { cell: 12, fps: 10, kf: 8 },
  { cell: 16, fps: 8, kf: 10 },
  { cell: 20, fps: 6, kf: 12 },
  { cell: 24, fps: 5, kf: 15 },
];

// Adaptive bitrate controller
export class AdaptiveController {
  constructor(cellsForCellSize) {
    this.cellsFor = cellsForCellSize;
    this.budgetKbps = CAP_DEFAULT_KBPS;
    this.bytesPerCell = CAP_PRIOR_BYTES_PER_CELL;
    this.level = 0;
    this.lastChange = 0;
    this.upSince = 0;
  }

  get settings() {
    return CAP_LADDER[this.level];
  }

  get levelCount() {
    return CAP_LADDER.length;
  }

  observe(deltaBytes, cells) {
    if (!cells) return;
    this.bytesPerCell += (deltaBytes / cells - this.bytesPerCell) * CAP_COST_SMOOTHING;
  }

  keyframeKbps(level) {
    const L = CAP_LADDER[level];
    return (this.cellsFor(L.cell) + KEY_HEADER_BYTES) * 8 / L.kf / 1000;
  }

  predictKbps(level) {
    const L = CAP_LADDER[level];
    const deltaKbps = L.fps * this.bytesPerCell * this.cellsFor(L.cell) * 8 / 1000;
    return this.keyframeKbps(level) + deltaKbps;
  }

  fits(level, fill) {
    return this.predictKbps(level) <= this.budgetKbps * fill
      && this.keyframeKbps(level) <= this.budgetKbps * CAP_KEYFRAME_SHARE;
  }

  best(fill) {
    for (let l = 0; l < CAP_LADDER.length; l++) if (this.fits(l, fill)) return l;
    return CAP_LADDER.length - 1;
  }

  moveTo(level, now) {
    const changed = level !== this.level;
    this.level = level;
    this.lastChange = now;
    this.upSince = 0;
    return changed;
  }

  start(now) {
    this.moveTo(this.best(CAP_UP_FILL), now);
  }

  setBudget(kbps, now) {
    this.budgetKbps = kbps;
    return this.moveTo(this.best(CAP_UP_FILL), now);
  }

  update(now, measuredKbps) {
    if (now - this.lastChange < CAP_SETTLE_MS) return false;
    const last = CAP_LADDER.length - 1;
    if (!this.fits(this.level, CAP_DOWN_FILL) && this.level < last) {
      return this.moveTo(Math.min(last, Math.max(this.level + 1, this.best(CAP_UP_FILL))), now);
    }
    if (measuredKbps > this.budgetKbps * CAP_OVERSHOOT_GUARD && this.level < last) {
      return this.moveTo(this.level + 1, now);
    }
    const target = this.best(CAP_UP_FILL);
    if (target < this.level) {
      if (!this.upSince) this.upSince = now;
      else if (now - this.upSince >= CAP_UPGRADE_HOLD_MS) return this.moveTo(target, now);
    } else {
      this.upSince = 0;
    }
    return false;
  }
}
