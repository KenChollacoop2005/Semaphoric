export const BG_K = 2.5;
export const BG_MIN_TOLERANCE = 0.04;
export const BG_COUNTDOWN_S = 5;
export const BG_CAPTURE_MS = 1500;
export const BG_HYSTERESIS_FRAMES = 3;
export const BG_SPECK_MIN_NEIGHBORS = 2;
export const BG_GAIN_MIN_MEAN = 0.05;
export const BG_GAIN_SAMPLE_STRIDE = 4;
export const BG_GAIN_MIN_BG_FRACTION = 0.2;
export const BG_GAIN_MIN = 0.25;
export const BG_GAIN_MAX = 4;
export const BG_GAIN_SMOOTHING = 0.3;

// Manual background subtraction, per-cell statistics
export class ManualBackground {
  constructor() {
    this.reset();
  }

  reset() {
    this.ready = false;
    this.count = 0;
    this.gain = 1;
  }

  begin(n) {
    this.ready = false;
    this.count = 0;
    this.mean = new Float32Array(n);
    this.m2 = new Float32Array(n);
  }

  // Welford running mean and variance
  addSample(lum) {
    const k = ++this.count;
    const { mean, m2 } = this;
    for (let i = 0; i < lum.length; i++) {
      const d = lum[i] - mean[i];
      mean[i] += d / k;
      m2[i] += d * (lum[i] - mean[i]);
    }
  }

  finish() {
    if (this.count < 2) return false;
    const n = this.mean.length;
    this.tolerance = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const std = Math.sqrt(this.m2[i] / (this.count - 1));
      this.tolerance[i] = Math.max(BG_K * std, BG_MIN_TOLERANCE);
    }
    this.stable = new Uint8Array(n);
    this.pending = new Uint8Array(n);
    this.ratios = new Float32Array(Math.ceil(n / BG_GAIN_SAMPLE_STRIDE));
    this.gain = 1;
    this.ready = true;
    return true;
  }

  // Nearest-neighbour resample of model to new grid
  resize(oldCols, oldRows, cols, rows) {
    if (!this.ready) return;
    const n = cols * rows;
    const mean = new Float32Array(n);
    const tolerance = new Float32Array(n);
    for (let r = 0; r < rows; r++) {
      const sr = Math.min(oldRows - 1, Math.floor((r + 0.5) * oldRows / rows));
      for (let c = 0; c < cols; c++) {
        const sc = Math.min(oldCols - 1, Math.floor((c + 0.5) * oldCols / cols));
        mean[r * cols + c] = this.mean[sr * oldCols + sc];
        tolerance[r * cols + c] = this.tolerance[sr * oldCols + sc];
      }
    }
    this.mean = mean;
    this.tolerance = tolerance;
    this.stable = new Uint8Array(n);
    this.pending = new Uint8Array(n);
    this.ratios = new Float32Array(Math.ceil(n / BG_GAIN_SAMPLE_STRIDE));
  }

  // Median brightness ratio vs model, from background cells
  estimateGain(lum, useMask) {
    const { mean, stable, ratios } = this;
    let k = 0;
    for (let i = 0; i < lum.length; i += BG_GAIN_SAMPLE_STRIDE) {
      if (mean[i] < BG_GAIN_MIN_MEAN) continue;
      if (useMask && stable[i]) continue;
      ratios[k++] = lum[i] / mean[i];
    }
    if (!k) return null;
    const sorted = ratios.subarray(0, k).sort();
    return sorted[k >> 1];
  }

  // Foreground mask: 1 = foreground, 0 = background
  classify(lum, cols, rows, outFg) {
    const { mean, tolerance, stable, pending } = this;

    // Undo global exposure drift before comparing
    let bgCells = 0;
    for (let i = 0; i < stable.length; i++) if (!stable[i]) bgCells++;
    const useMask = bgCells >= stable.length * BG_GAIN_MIN_BG_FRACTION;
    const measured = this.estimateGain(lum, useMask);
    if (measured !== null) {
      const clamped = Math.min(BG_GAIN_MAX, Math.max(BG_GAIN_MIN, measured));
      this.gain += (clamped - this.gain) * BG_GAIN_SMOOTHING;
    }
    const inv = 1 / this.gain;

    for (let i = 0; i < lum.length; i++) {
      const raw = Math.abs(lum[i] * inv - mean[i]) > tolerance[i] ? 1 : 0;
      if (raw === stable[i]) {
        pending[i] = 0;
      } else if (++pending[i] >= BG_HYSTERESIS_FRAMES) {
        stable[i] = raw;
        pending[i] = 0;
      }
    }
    removeSpecks(stable, cols, rows, BG_SPECK_MIN_NEIGHBORS, outFg);
  }
}

// Flip cells with too few matching neighbours
export function removeSpecks(mask, cols, rows, minSame, out) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const v = mask[i];
      let same = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if ((dr === 0 && dc === 0) || cc < 0 || cc >= cols) continue;
          if (mask[rr * cols + cc] === v) same++;
        }
      }
      out[i] = same >= minSame ? v : 1 - v;
    }
  }
}
