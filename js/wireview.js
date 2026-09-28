const HEAT_DECAY = 0.8;
const HEAT_MAX_ALPHA = 0.65;
const HEX_BYTES = 128;
const HEX_PER_LINE = 16;
const DELTA_RGB = [255, 176, 0];
const KEY_RGB = [255, 60, 200];

// Wire view
export class WireView {
  constructor(canvas, bytesEl) {
    this.canvas = canvas;
    this.bytesEl = bytesEl;
    this.ctx = canvas.getContext('2d');
    this.heat = new Float32Array(0);
    this.isKey = new Uint8Array(0);
  }

  resize(cols, rows) {
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.heat = new Float32Array(cols * rows);
    this.isKey = new Uint8Array(cols * rows);
    this.image = this.ctx.createImageData(cols, rows);
  }

  update(sentMask, key) {
    const { heat, isKey } = this;
    const px = this.image.data;
    for (let i = 0; i < heat.length; i++) {
      if (sentMask[i]) {
        heat[i] = 1;
        isKey[i] = key ? 1 : 0;
      } else {
        heat[i] *= HEAT_DECAY;
      }
      const rgb = isKey[i] ? KEY_RGB : DELTA_RGB;
      const o = i * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = heat[i] * HEAT_MAX_ALPHA * 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  clear() {
    this.heat.fill(0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.bytesEl.textContent = '';
  }

  showPacket(info, seqLabel) {
    if (!info || !info.bytes) return;
    const b = info.bytes;
    const kind = info.type === 'key' ? 'KEYFRAME' : `DELTA/${info.format.toUpperCase()}`;
    const lines = [`${kind}  #${seqLabel}  ${b.length} B  ${info.changed} cells`];
    if (info.type === 'delta') lines.push(`bitmask ${info.bitmaskSize} B vs runs ${info.runsSize} B`);
    const shown = Math.min(b.length, HEX_BYTES);
    for (let o = 0; o < shown; o += HEX_PER_LINE) {
      let hex = '';
      for (let j = o; j < Math.min(o + HEX_PER_LINE, shown); j++) hex += b[j].toString(16).padStart(2, '0') + ' ';
      lines.push(`${o.toString(16).padStart(5, '0')}  ${hex}`);
    }
    if (b.length > shown) lines.push(`… ${b.length - shown} more bytes`);
    this.bytesEl.textContent = lines.join('\n');
  }
}
