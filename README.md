# Semaphoric

```
 ____  _____ __  __    _    ____  _   _  ___  ____  ___ ____
/ ___|| ____|  \/  |  / \  |  _ \| | | |/ _ \|  _ \|_ _/ ___|
\___ \|  _| | |\/| | / _ \ | |_) | |_| | | | | |_) || | |
 ___) | |___| |  | |/ ___ \|  __/|  _  | |_| |  _ < | | |___
|____/|_____|_|  |_/_/   \_\_|   |_| |_|\___/|_| \_\___\____|
```

**Video is pixels. Semaphoric sends characters.**

Semaphoric turns a live webcam feed into ASCII art in the browser and streams that text directly to another browser, peer to peer, with no media server. The idea being tested: a text-based video stream can use a small fraction of the bandwidth of real video, and the same thing that makes ASCII look good (stability from frame to frame) is what makes it cheap to send.

That bandwidth claim is a **hypothesis, not a promise**. The app measures it live and shows real numbers next to an actual video stream over the same connection, whichever way they come out.

Vanilla JavaScript, ES modules, no framework, no build step.

---

## Features

- **Live ASCII filter.** Webcam to character grid at 30 fps, fully client-side.
- **Charsets.** Standard ramp, alphabet (sorted by measured ink coverage), custom strings, and a **braille mode** where each character is a 2×4 grid of dots: 8 "pixels" per cell at the same 1 byte per cell.
- **Background removal.** Off, **Auto** (MediaPipe selfie segmentation), or **Manual** (capture an empty room, then per-cell background subtraction with exposure-drift compensation, hysteresis and speck removal). Background cells are sent as one blank glyph, so they drop out of the stream once stable.
- **Peer-to-peer calls.**
  - **Room mode:** share a code like `amber-falcon-4172` or a link. Signaling runs through [Trystero](https://github.com/dmotz/trystero) over public Nostr relays.
  - **Manual mode:** copy-paste an offer and answer code. No third party at all beyond Google's public STUN server.
- **Proof UI.** Live kbps from `getStats()`, app payload vs. on-the-wire bytes, keyframe vs. delta sizes, % of cells changed, and a **real-video comparison toggle** that sends your actual webcam over the same connection and shows the ratio (`ASCII IS 1/N OF VIDEO`) on a rolling graph.
- **Experimental tab.**
  - **Adaptive bandwidth cap:** set a budget, e.g. 56 kbps dial-up, and it picks the best grid size, frame rate and keyframe spacing predicted to fit.
  - **Packet-loss simulation:** watch the stream glitch and recover on the next keyframe.
  - **Wire view:** a heatmap of which cells were actually sent this frame, next to a hex dump of the raw bytes.
- **CRT terminal UI**, because obviously.

---

## Running it

ES modules and camera access need a real origin, not `file://`:

```sh
python -m http.server 8000
# open http://localhost:8000
```

Any static file server works. The camera requires `localhost` or HTTPS, so a deployed copy (e.g. GitHub Pages) must be served over HTTPS.

**Try a call on one machine:** open two tabs. In the first, choose **HOST CALL**. Copy the link into the second tab and enter a name.

Tested mainly in Chromium browsers (Chrome, Opera).

---

## How it works

### The pipeline

```
 webcam ──► sample canvas ──► per-cell luminance ──► glyph index per cell (1 byte)
 (1280×720)  (2×4 px per cell,   (box average)          ├─ ramp: brightness → charset
              GPU downscale)                            └─ braille: 8 dots, ordered dither
                                                               │
                         background mask (auto / manual) ──────┤  bg cells → blank glyph
                                                               ▼
                                                    Uint8Array grid (cols × rows)
                                                               │
             ┌─────────────────────────────────────────────────┤
             ▼                                                 ▼
      render locally                          encode: keyframe or delta (smaller of 2)
      (<pre>, monospace)                                       │
                                               channel (optional simulated loss)
                                                               │
                                      loopback (solo)  or  WebRTC data channel (call)
                                                               │
                                                  decode ──► remote grid ──► render
```

The camera frame is drawn straight into a small canvas sized to exactly **2×4 sample pixels per cell**, so the browser does the heavy downscaling and JS only touches a few hundred thousand pixels, not the full camera frame. That 2×4 layout is also exactly one braille character.

### Wire protocol

Everything on the wire is a compact binary message (`js/protocol.js`). A cell is always a 1-byte glyph index. The charset travels once in `HELLO`, so the receiver can map indices back to characters in its own font.

| Type | Bytes | Contents |
|---|---|---|
| `KEYFRAME` | 8 + cells | type, seq (u16), grid epoch (u8), cols (u16), rows (u16), every cell |
| `DELTA` (bitmask) | 4 + ⌈cells/8⌉ + changed | header, 1 bit per cell, then the changed values |
| `DELTA` (runs) | 4 + varints + changed | header, (skip, length) varint pairs, then the changed values |
| `HELLO` | 7 + name + charset | protocol version, grid size, display name, charset (UTF-8) |
| `KEYFRAME_REQUEST` | 1 | sent on join, on loss, or on a decode error |
| `BYE` | 1 | clean disconnect |

- **Delta encoding.** Each delta is encoded both ways and the smaller one is sent. Measured: run-length wins for the standard ramp (changes cluster), and the bitmask wins for braille (dithered changes scatter).
- **Unchanged frames** send nothing at all.
- **The grid epoch** changes on every resize, so a delta can never be applied to a grid of the wrong shape, even if the keyframe after a resize is lost.
- **Keyframes** go out on a timer, on request, and after any grid or charset change.

### Calls

Both connection modes implement one transport interface, so the protocol and UI don't care which one is in use:

```
send(bytes) · onMessage · onPeerJoin / onPeerLeave · getPeerConnection()
addVideoTrack(track) / removeVideoTrack() · close()
```

- **Room mode** (`transport-room.js`): Trystero finds the peer through public Nostr relays, then WebRTC connects the two browsers directly. The host admits the first peer and turns away any later ones with `ROOM FULL`.
- **Manual mode** (`transport-manual.js`): a raw `RTCPeerConnection`. The offer and answer are deflated and base64url-encoded into codes of about 550–660 characters. Adding the real-video track later is renegotiated over a small second "signal" data channel, which avoids a second round of copy-paste.

**Privacy:** WebRTC encrypts data channels and media automatically. Nothing (names, codes, frames) is stored anywhere. Because the connection is direct, each browser can see the other's IP address.

---

## Code layout

```
index.html          UI shell: stage, start menu, sidebar
style.css           CRT theme
js/
  ui.js             app glue: frame loop, controls, call flows, layout
  capture.js        getUserMedia, sample canvas, luminance, auto-exposure reset
  filter-cpu.js     per-cell luminance, naive ramp, braille dither filter
  glyphs.js         charset presets, glyph measurement, font stack
  render.js         grid of indices → text
  background.js     manual background subtraction model
  segment-auto.js   MediaPipe selfie segmentation → per-cell mask
  protocol.js       binary message encode / decode
  link.js           Sender (pacing, keyframe vs delta), Receiver, lossy Channel
  adaptive.js       bandwidth-cap controller (predictive quality ladder)
  wireview.js       sent-cell heatmap + hex dump
  stats.js          FPS, timings, wire rates, per-mode averages
  call.js           call session: status, transport, remote receiver, getStats
  transport.js      picks room or manual transport
  transport-room.js     Trystero room, gated to two peers
  transport-manual.js   raw RTCPeerConnection + copy-paste signaling
  roomcode.js       word-word-NNNN codes from crypto.getRandomValues
  screens.js        start menu, prompts, call cards, manual panel
  netgraph.js       rolling kbps graph (log scale, plain canvas)
```

Tunable values (thresholds, fps caps, keyframe intervals, timeouts) are named constants at the top of each module.

**External code, loaded from CDNs at runtime:**
- Trystero, only when a room call starts.
- MediaPipe Tasks Vision, only when Auto background is selected.
- Google Fonts: VT323 for the UI, and Noto Sans Symbols 2 so all 256 braille patterns render at the same width.

---

## Measured so far

Early numbers, from headless Chrome with a synthetic test video. They are **indicative, not final**; real-webcam figures will replace them.

| | Result |
|---|---|
| Filter cost | ~3–5 ms/frame (camera-capped at 30 fps) |
| Full-res ASCII stream (256×79, 15 fps, no stabilization) | ~330–450 kbps |
| Real 720p video over the same link | ~1.7 Mbps |
| Ratio at full res, unstabilized | ASCII ≈ 1/4 to 1/5 of video |
| With 56 kbps cap (adaptive) | settles at cell size 10, 10 fps, ~30–50 kbps |
| Time to connect (two tabs) | ~1.8 s manual, ~1.9 s room |

So at full resolution without temporal stabilization, the stream is not yet "a small fraction" of video. Stabilization is the next lever, and this table will be updated honestly either way.

---

## Status and roadmap

- [x] Capture, naive filter, stats overlay
- [x] Charset presets, braille mode
- [x] Background removal (auto + manual)
- [x] Wire protocol, loopback, adaptive cap, loss simulation, wire view
- [x] P2P calls (room + manual), live counter, real-video comparison
- [ ] Font-calibrated glyph ramp for arbitrary charsets
- [ ] Temporal stabilization (per-cell hysteresis)
- [ ] Edge-aware directional glyphs (`/ \ | _ -`)
- [ ] WebGL2 filter path
- [ ] Test on two devices, including on campus Wi-Fi (no TURN relay by design, so some networks may block the direct connection)

**Not planned:** audio, accounts, more than two peers, TURN relay, color on the wire.

See [`SPEC.md`](SPEC.md) and [`P2P_SPEC.md`](P2P_SPEC.md) for the full build spec.
