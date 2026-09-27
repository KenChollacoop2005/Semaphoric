# Project Semaphoric — Build Spec

## Thesis
Video is pixels. Semaphoric sends *characters*. A live webcam feed is converted into high-quality, stable ASCII art, and that text stream is sent directly between two browsers (peer-to-peer, no server). The claim to test and show: a text-based video stream can use a small fraction of the bandwidth of a real video stream, and the same technique that makes the ASCII look good (temporal stability) is what makes it cheap to send.

The bandwidth win is a **hypothesis to measure**, not a promise. The UI reports real numbers either way.

## Build order
Filter first. P2P only starts once the filter is solid.

### Phase 1 — The filter (local, single browser)
1. **Capture.** `getUserMedia` webcam → offscreen canvas. Monochrome output for v1.
2. **Naive baseline mode.** Brightness-per-cell → fixed character ramp. Kept permanently as a toggle for before/after comparison.
3. **Font-calibrated glyph ramp.** Render every glyph of the chosen font + charset to a canvas, measure actual ink coverage, build the brightness ramp from measured data. Must work for any monospace font and any charset (ASCII, box-drawing, katakana, custom string).
4. **Temporal stabilization.** Hysteresis per cell: a cell only switches glyph when the new candidate beats the current one by a tunable margin (optionally sustained for N frames). Goal: kill the frame-to-frame flicker.
5. **Edge-aware glyphs.** Edge detection (e.g. Sobel or difference-of-Gaussians) per cell; where edge strength is high, pick a directional glyph (`/ \ | _ -`) matching edge angle instead of a brightness glyph.
6. **Controls.** Cell size, font, charset, stabilization margin, edge threshold, and on/off toggles for each stage (so every improvement can be shown in isolation).
7. **Stats overlay.** FPS, grid size, and **% of cells changed per frame** (this number becomes the bandwidth story in Phase 3).

### Phase 2 — GPU path
- WebGL2 fragment shader computes the glyph index per cell (brightness, edges, hysteresis state in a texture).
- Read back only the small index texture (cols × rows bytes), not the full image.
- Keep the CPU path; add a toggle and report FPS for both.

### Phase 3 — Peer-to-peer
- `RTCPeerConnection` + one `RTCDataChannel`. Public Google STUN server only. No TURN, no signaling server.
- **Copy-paste signaling:** caller clicks "Create call" → wait for ICE gathering to complete → show one compact code (compressed + base64) to copy. Callee pastes it, gets an answer code back to paste to the caller.
- **Wire protocol (binary):**
  - Keyframe: header + full grid of glyph indices (1 byte/cell).
  - Delta frame: header + changed cells only (Claude Code to compare a changed-cell bitmask vs run-length positions and pick the smaller).
  - Periodic keyframe every N seconds and on request (recovery).
  - Optional `CompressionStream('deflate-raw')` on payloads; measure with and without.
- Frame rate cap (default ~15 fps) and grid size shared between peers.
- Both peers see their own ASCII and the remote ASCII side by side.

### Phase 4 — Proof UI
- **Live counter:** bytes/sec and kbps sent on the data channel, plus average bytes per frame, split into keyframe vs delta.
- **Real-video comparison toggle:** adds an actual webcam video track to the same connection; read its `outbound-rtp` bytes from `getStats()`. Display both rates side by side with the ratio.
- Small live graph of both rates over time.
- Show % cells changed alongside, so the link between stability and bandwidth is visible.

## Non-goals
Audio. Any server or account system. TURN relay. More than two peers. Color on the wire (possible later, must be measured). Mobile polish.

## Known risk
Some networks (possibly VT campus Wi-Fi) block direct browser-to-browser connections without a TURN relay. Test on campus early in Phase 3. If it fails, document it honestly in the entry as a limitation of P2P, not hide it. Two tabs on one machine work for development.

## Tech
- Vanilla JS + HTML + CSS, ES modules, no framework, no build step.
- Deployed on GitHub Pages from its own repo (`KenChollacoop2005/semaphoric`), separate from K.C. Bulletin.
- Suggested modules: `capture.js`, `glyphs.js` (font calibration), `filter-cpu.js`, `filter-gpu.js`, `stabilize.js`, `edges.js`, `peer.js` (signaling + data channel), `protocol.js` (encode/decode), `stats.js`, `ui.js`.
- Testing browser: Opera (Chromium).

## Material to capture for the portfolio entry
- Before/after stills and a short clip: naive vs final, with each stage toggled.
- Pipeline diagram: camera → cells → calibrated glyphs + edges → stabilization → delta encode → data channel.
- Measured numbers: FPS (CPU vs GPU), % cells changed (stabilization off vs on), ASCII kbps vs real video kbps.

## Definition of done
Phase 1 + Phase 3 + the live counter are the minimum shippable version. Phase 2 and the real-video comparison toggle complete it.
