const GRAPH_MIN_KBPS = 1;
const GRAPH_MAX_KBPS = 10000;
const GRID_KBPS = [10, 100, 1000];
const ASCII_COLOR = '#33ff66';
const VIDEO_COLOR = '#ffb000';
const GRID_COLOR = 'rgba(51, 255, 102, 0.18)';
const LABEL_COLOR = 'rgba(51, 255, 102, 0.55)';
const LABEL_FONT = '12px VT323, monospace';

// Network graph
export function drawNetGraph(canvas, history, capacity) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const logMin = Math.log10(GRAPH_MIN_KBPS);
  const logMax = Math.log10(GRAPH_MAX_KBPS);
  const y = (kbps) => h - (Math.log10(Math.max(GRAPH_MIN_KBPS, kbps)) - logMin) / (logMax - logMin) * h;
  const x = (i) => (w * i) / Math.max(1, capacity - 1);

  ctx.font = LABEL_FONT;
  ctx.lineWidth = 1;
  for (const g of GRID_KBPS) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(g)) + 0.5);
    ctx.lineTo(w, Math.round(y(g)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(g >= 1000 ? `${g / 1000}M` : `${g}k`, 2, y(g) - 2);
  }

  const offset = capacity - history.length;
  const line = (key, color, include) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    history.forEach((p, i) => {
      if (!include(p)) { pen = false; return; }
      const px = x(offset + i);
      const py = y(p[key]);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    });
    ctx.stroke();
  };
  line('video', VIDEO_COLOR, (p) => p.comparing);
  line('ascii', ASCII_COLOR, () => true);
}
