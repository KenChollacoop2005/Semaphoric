# Project Semaphoric — P2P Call Spec

Read alongside `SPEC.md` and `CLAUDE.md`. This spec covers the start-screen UI, joining a call, the peer-to-peer connection, and the proof UI. The filter, background modes, and Experimental tab are already built and are not changed here except where noted.

## Goal
Two people on different devices see each other as live ASCII. The video never touches a server. The UI measures and shows how little bandwidth that takes, next to real video over the same connection.

## Pre-check (5 minutes)
Confirm the existing experimental features run frames through `protocol.js` encode **and** decode before rendering. If decode is not exercised anywhere yet, add a quick self-check (encode → decode → compare grid) before starting networking. Report the result.

---

## Part 1 — Start screen

Replace the single `START CAMERA` button with a terminal-style menu in the same centered position, same styling:

```
> START CAMERA_
> HOST CALL
> JOIN CALL
    manual connect
```

- Arrow keys and Enter move and select; mouse click also works. The blinking cursor sits on the selected line.
- **START CAMERA:** current solo behavior, unchanged.
- **HOST CALL:** prompt `DISPLAY NAME:` → start camera → generate room code → show hosting screen (Part 2).
- **JOIN CALL:** prompt `DISPLAY NAME:` then `ROOM CODE:` → start camera → connect.
- **manual connect:** smaller, dimmer line under JOIN CALL. Opens the manual signaling panel (Part 3B).
- `Esc` backs out of any prompt to the menu.

### Display name
- Free text, trimmed, max 16 chars, no accounts, no storage beyond the session.
- Remembered for the session only so a user rejoining doesn't retype it.

### URL hash join
- If the page loads with `#word-word-1234`, skip the menu and go straight to JOIN CALL with the code prefilled; only the name prompt is shown.
- The hosting screen's copy button copies the full link including the hash.

## Part 2 — In-call UI

### Hosting / connecting states
Shown in the main view until a peer connects, using the existing terminal voice:
- Host: room code in large text, `[COPY CODE]` and `[COPY LINK]`, then `AWAITING PEER...` with animated ellipsis.
- Joiner: `CONNECTING TO amber-falcon-4172...`
- On success, both: `LINK ESTABLISHED` for about a second, then the call layout.
- On failure or timeout (constant, default 20 s): `NO ROUTE TO PEER` plus a one-line hint that some networks block direct connections, and options `[RETRY]` `[TRY MANUAL CONNECT]` `[BACK]`.

### Call layout
- **Default:** remote ASCII large in the main view; local ASCII picture-in-picture in a corner, each labelled with its display name.
- **Toggle:** side-by-side, equal size (for comparison clips).
- Local background mode, font, charset, and cell size settings affect only the local render and what is sent. The receiver renders the grid it receives with its own font.

### New sidebar section: CONNECTION
Placed between BACKGROUND and EXPERIMENTAL. Hidden or collapsed in solo mode.
- Status: `SOLO` / `HOSTING` / `CONNECTING` / `LINKED` / `LOST`
- Mode: `ROOM` or `MANUAL`
- Room code with copy button (room mode only)
- Peer display name
- Live counter (Part 4)
- Layout toggle: PiP / side-by-side
- `DISCONNECT` button → returns to the start menu, camera stays on

---

## Part 3 — Connection

### Shared transport layer
Both connection modes produce the same interface so the protocol and UI don't care which was used:

```
transport.send(bytes)
transport.onMessage(bytes => ...)
transport.onPeerJoin / onPeerLeave
transport.getPeerConnection()   // for getStats
transport.addVideoTrack(track) / removeVideoTrack()
transport.close()
```

Suggested files: `transport-room.js`, `transport-manual.js`, and a thin `transport.js` that picks one.

### 3A — Room mode (default)
- Signaling via **Trystero**, loaded from CDN. Use its default strategy; if connections are unreliable in testing, try another strategy and report which works best.
- App ID constant namespaced to the project, e.g. `semaphoric-v1`, so rooms never collide with other Trystero apps.
- Room code: `word-word-NNNN` from a small built-in word list, generated with `crypto.getRandomValues`.
- Max 2 peers. A third peer joining is told `ROOM FULL` and disconnected.
- Exchange display names on join as a small control message.
- Verify against Trystero's current docs how to access the underlying `RTCPeerConnection` (for `getStats`) and how to add or remove a media track. Flag if either isn't possible.

### 3B — Manual mode
- Raw `RTCPeerConnection` with one `RTCDataChannel`. Public Google STUN only. No TURN.
- Panel with two steps and a large monospace text box for each:
  - Caller: `[CREATE OFFER]` → wait for ICE gathering to complete → show compact offer code (compressed + base64) with copy button → paste box for the answer.
  - Callee: paste box for the offer → `[CREATE ANSWER]` → show answer code with copy button.
- Show code length in characters next to each code.
- Display names exchanged the same way as room mode once the channel opens.

### Security and privacy notes
- WebRTC encrypts data channels and media automatically; nothing extra to build.
- In the entry and in a small `?` info line in the CONNECTION section: a direct connection means each peer's browser can see the other's IP address.
- No names, codes, or frames are stored anywhere.

---

## Part 4 — Streaming and proof UI

### Wire protocol (from SPEC.md, now over the network)
- Message types: `HELLO` (display name, grid cols/rows, protocol version), `KEYFRAME`, `DELTA`, `KEYFRAME_REQUEST`, `BYE`.
- Keyframe every N seconds (constant) and whenever the receiver sends `KEYFRAME_REQUEST` (on join, on grid size change, on decode error).
- If the sender's grid size or charset changes, send `HELLO` again, then a keyframe.
- Frame rate cap constant, default 15 fps.
- Send glyph indices plus the charset string in `HELLO`, so the receiver maps indices back to characters.

### Background modes and bandwidth
- Background cells (Auto or Manual mode) are sent as a single "blank" index, so they stop appearing in deltas once stable. This should show up in the counter.

### Live counter
In the CONNECTION section:
- ASCII stream: kbps sent, kbps received, average bytes per frame, split into keyframe vs delta.
- % cells changed per frame (already exists; show it here too while in a call).
- Source of truth: `getStats()` data-channel `bytesSent` / `bytesReceived` where available, so protocol and library overhead are included. Also show the app-level payload bytes, and label both clearly.

### Real-video comparison toggle
- `[COMPARE WITH REAL VIDEO]` adds the actual webcam video track to the same connection.
- Read its bitrate from `getStats()` `outbound-rtp` (kind `video`).
- Display both rates side by side, plus the ratio (e.g. `ASCII IS 1/38 OF VIDEO`).
- The receiver may show the real video in a small hidden or muted element; it only needs to flow so it is measured honestly.
- Toggling off removes the track.

### Live graph
- Small rolling graph (last 30 s) of ASCII kbps and, when enabled, real-video kbps. Canvas, terminal-styled, no chart library.

---

## Part 5 — Robustness
- Peer leaves or connection drops: status `LOST`, message `PEER DISCONNECTED`, return to the hosting screen (host) or the menu (joiner) after a short delay.
- Tab hidden: keep the connection alive, and pause sending frames until the tab is visible again.
- Camera permission denied: clear message, back to the menu.
- Decode error: drop the frame, send `KEYFRAME_REQUEST`.

## Testing
1. Two tabs, same machine: room mode and manual mode.
2. Two devices, same home network.
3. **Two devices on VT Wi-Fi.** Report whether the direct link forms. If it doesn't, do not add a TURN server; document it as a known limitation.
4. Phone as the second device if possible (layout doesn't need polish, it just has to connect).
5. Record for each test: connection mode, time to connect, ASCII kbps, video kbps, ratio.

## Out of scope for this spec
Audio. Accounts. More than two peers. TURN relay. Record-to-text-file (separate task, reuses the protocol). Flag semaphore (deferred). Color on the wire.

## Definition of done
- Menu, host, join, URL-hash join, and manual connect all work.
- A two-device call shows both ASCII feeds with correct names.
- The live counter shows real measured numbers, and the real-video toggle produces an honest side-by-side ratio.
- VT Wi-Fi result reported either way.
