const BRAILLE_DITHER = true;
const BRAILLE_LOW_PCT = 2;
const BRAILLE_HIGH_PCT = 98;
const BRAILLE_RANGE_SMOOTHING = 0.1;
const BRAILLE_MIN_RANGE = 0.05;

// Braille dot bits
const BRAILLE_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
// Dither thresholds
const BRAILLE_THRESHOLDS = [[0, 4], [6, 2], [1, 5], [7, 3]].map((r) => r.map((k) => (k + 0.5) / 8));

// Cell luminance
export function cellLuminance(luma, width, height, cols, rows, out) {
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor(r * height / rows);
    const y1 = Math.floor((r + 1) * height / rows);
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(c * width / cols);
      const x1 = Math.floor((c + 1) * width / cols);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) sum += luma[row + x];
      }
      out[r * cols + c] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
}

// Naive ramp
export function naiveIndices(cellLum, rampLength, out) {
  const last = rampLength - 1;
  for (let i = 0; i < cellLum.length; i++) {
    out[i] = Math.min(last, Math.floor(cellLum[i] * rampLength));
  }
}

// Braille filter
export class BrailleFilter {
  constructor() {
    this.hist = new Uint32Array(256);
    this.reset();
  }

  reset() {
    this.lo = 0;
    this.hi = 1;
    this.primed = false;
  }

  updateRange(luma) {
    const hist = this.hist;
    hist.fill(0);
    for (let i = 0; i < luma.length; i++) hist[Math.min(255, (luma[i] * 255) | 0)]++;
    const loTarget = luma.length * BRAILLE_LOW_PCT / 100;
    const hiTarget = luma.length * BRAILLE_HIGH_PCT / 100;
    let acc = 0, lo = 0, hi = 255;
    for (let b = 0; b < 256; b++) {
      acc += hist[b];
      if (acc <= loTarget) lo = b;
      if (acc < hiTarget) hi = b + 1;
    }
    lo /= 255;
    hi = Math.max(lo + BRAILLE_MIN_RANGE, hi / 255);
    if (!this.primed) {
      this.lo = lo;
      this.hi = hi;
      this.primed = true;
    } else {
      this.lo += (lo - this.lo) * BRAILLE_RANGE_SMOOTHING;
      this.hi += (hi - this.hi) * BRAILLE_RANGE_SMOOTHING;
    }
  }

  run(luma, sampleWidth, cols, rows, out) {
    this.updateRange(luma);
    const lo = this.lo;
    const scale = 1 / Math.max(BRAILLE_MIN_RANGE, this.hi - lo);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let bits = 0;
        for (let dy = 0; dy < 4; dy++) {
          const row = (r * 4 + dy) * sampleWidth + c * 2;
          for (let dx = 0; dx < 2; dx++) {
            const v = (luma[row + dx] - lo) * scale;
            const t = BRAILLE_DITHER ? BRAILLE_THRESHOLDS[dy][dx] : 0.5;
            if (v > t) bits |= BRAILLE_BITS[dy][dx];
          }
        }
        out[r * cols + c] = bits;
      }
    }
  }
}
