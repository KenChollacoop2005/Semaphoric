export const MSG_KEYFRAME = 1;
export const MSG_DELTA_BITMASK = 2;
export const MSG_DELTA_RUNS = 3;
export const MSG_HELLO = 16;
export const MSG_KEY_REQUEST = 17;
export const MSG_BYE = 18;
export const PROTOCOL_VERSION = 1;

// Header sizes
export const KEY_HEADER_BYTES = 8;
export const DELTA_HEADER_BYTES = 4;
const HELLO_HEADER_BYTES = 7;
const MAX_NAME_BYTES = 64;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeU16(buf, o, v) {
  buf[o] = v & 0xff;
  buf[o + 1] = (v >> 8) & 0xff;
}

function readU16(buf, o) {
  return buf[o] | (buf[o + 1] << 8);
}

function varintSize(v) {
  let n = 1;
  while (v >= 0x80) { v >>>= 7; n++; }
  return n;
}

function writeVarint(buf, o, v) {
  while (v >= 0x80) {
    buf[o++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  buf[o++] = v;
  return o;
}

function readVarint(buf, o) {
  let v = 0, shift = 0, b;
  do {
    b = buf[o++];
    v |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [v, o];
}

function writeHeader(out, type, seq, epoch) {
  out[0] = type;
  writeU16(out, 1, seq);
  out[3] = epoch;
}

// Frame encoding
export function encodeKeyframe(seq, epoch, cols, rows, grid) {
  const out = new Uint8Array(KEY_HEADER_BYTES + grid.length);
  writeHeader(out, MSG_KEYFRAME, seq, epoch);
  writeU16(out, 4, cols);
  writeU16(out, 6, rows);
  out.set(grid, KEY_HEADER_BYTES);
  return out;
}

export function encodeDelta(seq, epoch, prev, cur, sentMask) {
  const n = cur.length;
  let changed = 0, runs = 0, runBytes = 0, lastEnd = 0, i = 0;
  while (i < n) {
    if (prev[i] === cur[i]) { sentMask[i] = 0; i++; continue; }
    const start = i;
    while (i < n && prev[i] !== cur[i]) { sentMask[i] = 1; i++; }
    runs++;
    changed += i - start;
    runBytes += varintSize(start - lastEnd) + varintSize(i - start);
    lastEnd = i;
  }
  if (!changed) return null;

  const maskBytes = Math.ceil(n / 8);
  const bitmaskSize = DELTA_HEADER_BYTES + maskBytes + changed;
  const runsSize = DELTA_HEADER_BYTES + varintSize(runs) + runBytes + changed;
  const useRuns = runsSize <= bitmaskSize;
  let out;

  if (useRuns) {
    out = new Uint8Array(runsSize);
    writeHeader(out, MSG_DELTA_RUNS, seq, epoch);
    let o = writeVarint(out, DELTA_HEADER_BYTES, runs);
    let vo = runsSize - changed;
    lastEnd = 0;
    i = 0;
    while (i < n) {
      if (!sentMask[i]) { i++; continue; }
      const start = i;
      while (i < n && sentMask[i]) out[vo++] = cur[i++];
      o = writeVarint(out, o, start - lastEnd);
      o = writeVarint(out, o, i - start);
      lastEnd = i;
    }
  } else {
    out = new Uint8Array(bitmaskSize);
    writeHeader(out, MSG_DELTA_BITMASK, seq, epoch);
    let vo = DELTA_HEADER_BYTES + maskBytes;
    for (let j = 0; j < n; j++) {
      if (!sentMask[j]) continue;
      out[DELTA_HEADER_BYTES + (j >> 3)] |= 1 << (j & 7);
      out[vo++] = cur[j];
    }
  }
  return { bytes: out, changed, bitmaskSize, runsSize, format: useRuns ? 'runs' : 'bitmask' };
}

// Control messages
export function encodeHello(name, cols, rows, glyphs) {
  const nameBytes = textEncoder.encode(name).subarray(0, MAX_NAME_BYTES);
  const charset = textEncoder.encode(glyphs.join(''));
  const out = new Uint8Array(HELLO_HEADER_BYTES + nameBytes.length + charset.length);
  out[0] = MSG_HELLO;
  out[1] = PROTOCOL_VERSION;
  writeU16(out, 2, cols);
  writeU16(out, 4, rows);
  out[6] = nameBytes.length;
  out.set(nameBytes, HELLO_HEADER_BYTES);
  out.set(charset, HELLO_HEADER_BYTES + nameBytes.length);
  return out;
}

export function decodeHello(buf) {
  if (buf.length < HELLO_HEADER_BYTES) throw new Error('short hello');
  const nameEnd = HELLO_HEADER_BYTES + buf[6];
  if (nameEnd > buf.length) throw new Error('bad hello name');
  return {
    version: buf[1],
    cols: readU16(buf, 2),
    rows: readU16(buf, 4),
    name: textDecoder.decode(buf.subarray(HELLO_HEADER_BYTES, nameEnd)),
    glyphs: Array.from(textDecoder.decode(buf.subarray(nameEnd))),
  };
}

export function encodeKeyRequest() {
  return Uint8Array.of(MSG_KEY_REQUEST);
}

export function encodeBye() {
  return Uint8Array.of(MSG_BYE);
}

// Frame decoding
export function decodeKeyframe(buf) {
  if (buf.length < KEY_HEADER_BYTES) throw new Error('short keyframe');
  const cols = readU16(buf, 4);
  const rows = readU16(buf, 6);
  if (buf.length !== KEY_HEADER_BYTES + cols * rows) throw new Error('keyframe size mismatch');
  return {
    seq: readU16(buf, 1),
    epoch: buf[3],
    cols,
    rows,
    grid: buf.subarray(KEY_HEADER_BYTES),
  };
}

export function deltaHeader(buf) {
  return { seq: readU16(buf, 1), epoch: buf[3] };
}

export function applyDelta(buf, grid) {
  const n = grid.length;
  if (buf[0] === MSG_DELTA_BITMASK) {
    const maskBytes = Math.ceil(n / 8);
    let vo = DELTA_HEADER_BYTES + maskBytes;
    if (vo > buf.length) throw new Error('short bitmask');
    for (let j = 0; j < n; j++) {
      if (buf[DELTA_HEADER_BYTES + (j >> 3)] & (1 << (j & 7))) {
        if (vo >= buf.length) throw new Error('bitmask values truncated');
        grid[j] = buf[vo++];
      }
    }
    return;
  }
  let [runs, o] = readVarint(buf, DELTA_HEADER_BYTES);
  const positions = [];
  let pos = 0;
  for (let r = 0; r < runs; r++) {
    let skip, len;
    [skip, o] = readVarint(buf, o);
    [len, o] = readVarint(buf, o);
    if (o > buf.length) throw new Error('runs truncated');
    pos += skip;
    if (pos + len > n) throw new Error('run out of grid');
    positions.push(pos, len);
    pos += len;
  }
  let vo = o;
  for (let r = 0; r < positions.length; r += 2) {
    const end = positions[r] + positions[r + 1];
    if (vo + positions[r + 1] > buf.length) throw new Error('run values truncated');
    for (let j = positions[r]; j < end; j++) grid[j] = buf[vo++];
  }
}
