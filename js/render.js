const MISSING_GLYPH = ' ';

export function gridToText(indices, cols, rows, glyphs) {
  let out = '';
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) out += glyphs[indices[base + c]] ?? MISSING_GLYPH;
    out += '\n';
  }
  return out;
}
