const MEASURE_FONT_PX = 100;
const COVERAGE_FONT_PX = 32;
const MAX_GLYPHS = 256;
const BRAILLE_BASE = 0x2800;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const DEFAULT_ASPECT_SAMPLE = 'M';
export const BRAILLE_ASPECT_SAMPLE = '⣿';
// All 256 braille patterns share one width here
export const BRAILLE_FONT = 'Noto Sans Symbols 2';

const measureCtx = new OffscreenCanvas(1, 1).getContext('2d');

// Chosen font, braille fallback, generic
export function fontStack(font) {
  return `"${font}", "${BRAILLE_FONT}", monospace`;
}

export function loadBrailleFont() {
  return document.fonts.load(`16px "${BRAILLE_FONT}"`, '⠀' + BRAILLE_ASPECT_SAMPLE);
}

// Glyph width / font size for monospace font
export function measureGlyphAspect(font, sample = DEFAULT_ASPECT_SAMPLE) {
  measureCtx.font = `${MEASURE_FONT_PX}px ${fontStack(font)}`;
  return measureCtx.measureText(sample).width / MEASURE_FONT_PX;
}

// Split charset into glyphs, 1 byte index cap
export function parseCharset(str) {
  return Array.from(str).slice(0, MAX_GLYPHS);
}

// All 256 braille patterns; index = dot bits
export function brailleCharset() {
  let s = '';
  for (let i = 0; i < 256; i++) s += String.fromCharCode(BRAILLE_BASE + i);
  return s;
}

// Glyphs sorted light to dark by measured ink
export function sortByCoverage(font, glyphs) {
  const size = COVERAGE_FONT_PX;
  const ctx = new OffscreenCanvas(size * 2, size * 2).getContext('2d', { willReadFrequently: true });
  ctx.font = `${size}px "${font}"`;
  ctx.textBaseline = 'top';
  const coverage = glyphs.map((g) => {
    ctx.clearRect(0, 0, size * 2, size * 2);
    ctx.fillText(g, 0, 0);
    const px = ctx.getImageData(0, 0, size * 2, size * 2).data;
    let sum = 0;
    for (let i = 3; i < px.length; i += 4) sum += px[i];
    return sum;
  });
  return glyphs
    .map((g, i) => [g, coverage[i]])
    .sort((a, b) => a[1] - b[1])
    .map(([g]) => g);
}

// Preset text for the charset box
export function presetCharset(name, font) {
  switch (name) {
    case 'braille': return brailleCharset();
    case 'alphabet': return ' ' + sortByCoverage(font, Array.from(LETTERS)).join('');
    case 'custom': return '.';
    default: return ' .:-=+*#%@';
  }
}
