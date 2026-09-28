import { createTransport } from './transport.js';
import { Receiver } from './link.js';
import {
  MSG_KEY_REQUEST, MSG_BYE, PROTOCOL_VERSION, encodeKeyRequest, encodeBye,
} from './protocol.js';

export const CONNECT_TIMEOUT_MS = 20000;
const MANUAL_REPLY_WAIT_MS = 10 * 60 * 1000;
const ROUTE_NAMES = { host: 'LOCAL', srflx: 'PUBLIC', prflx: 'PEER-SEEN', relay: 'RELAY' };
const STATS_POLL_MS = 1000;
export const GRAPH_WINDOW_S = 30;

// Call session
export class Call {
  constructor() {
    this.listeners = {};
    this.receiver = new Receiver();
    this.receiver.onKeyRequest = () => this.send(encodeKeyRequest());
    this.receiver.onHello = (h) => this.onHello(h);
    this.reset();
  }

  on(event, fn) {
    (this.listeners[event] ??= []).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }

  reset() {
    this.status = 'solo';
    this.mode = null;
    this.role = null;
    this.code = null;
    this.name = '';
    this.peerName = '';
    this.transport = null;
    this.comparing = false;
    this.failInfo = '';
    this.linkedAt = 0;
    this.startedAt = 0;
    clearTimeout(this.timeout);
    clearInterval(this.poller);
    this.timeout = null;
    this.poller = null;
    this.receiver.reset();
    this.resetNet();
  }

  resetNet() {
    this.payload = { sent: 0, recv: 0 };
    this.prev = null;
    this.net = { dcSent: 0, dcRecv: 0, paySent: 0, payRecv: 0, videoSent: 0, videoRecv: 0, hasDcStats: false };
    this.history = [];
  }

  get active() {
    return this.status !== 'solo';
  }

  get linked() {
    return this.status === 'linked';
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.emit('status', status, detail);
  }

  async host(name, code) {
    this.begin('room', 'host', name);
    this.code = code;
    this.setStatus('hosting');
    await this.open('room', { code, role: 'host' });
  }

  async join(name, code) {
    this.begin('room', 'join', name);
    this.code = code;
    this.setStatus('connecting');
    this.armTimeout();
    await this.open('room', { code, role: 'join' });
  }

  // Manual connect
  async manualOffer(name) {
    this.begin('manual', 'caller', name);
    this.setStatus('connecting');
    await this.open('manual');
    return this.transport.createOffer();
  }

  async manualAnswer(code) {
    await this.transport.acceptAnswer(code);
    this.armTimeout();
  }

  async manualAccept(name, offerCode) {
    this.begin('manual', 'callee', name);
    this.setStatus('connecting');
    await this.open('manual');
    const answer = await this.transport.acceptOffer(offerCode);
    this.armTimeout(MANUAL_REPLY_WAIT_MS, 'YOUR FRIEND NEVER USED THE REPLY CODE');
    return answer;
  }

  begin(mode, role, name) {
    this.close(false);
    this.mode = mode;
    this.role = role;
    this.name = name;
    this.startedAt = performance.now();
  }

  armTimeout(ms = CONNECT_TIMEOUT_MS, reason = 'NO ROUTE TO PEER') {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      if (!this.linked) this.fail(reason);
    }, ms);
  }

  // Diagnostics
  diagnose() {
    const pc = this.transport?.getPeerConnection?.();
    if (!pc) return this.mode === 'room' ? 'NO PEER ANSWERED IN THIS ROOM.' : '';
    const types = (desc) => new Set([...(desc?.sdp ?? '').matchAll(/ typ (\w+)/g)].map((m) => m[1]));
    const fmt = (set) => [...set].map((t) => ROUTE_NAMES[t] ?? t.toUpperCase()).join(', ') || 'NONE';
    const local = types(pc.localDescription);
    const remote = types(pc.remoteDescription);
    const lines = [`YOUR ROUTES: ${fmt(local)} · THEIRS: ${fmt(remote)} · ICE: ${pc.iceConnectionState.toUpperCase()}`];
    if (!local.has('srflx')) lines.push('NO PUBLIC ROUTE ON YOUR SIDE: THIS NETWORK MAY BLOCK UDP.');
    else if (remote.size && !remote.has('srflx')) lines.push('NO PUBLIC ROUTE ON THEIR SIDE: THEIR NETWORK MAY BLOCK UDP.');
    return lines.join('\n');
  }

  async open(kind, options) {
    const t = await createTransport(kind, options);
    if (this.status === 'solo') {
      t.close();
      return;
    }
    this.transport = t;
    t.onPeerJoin = () => this.linkUp();
    t.onPeerLeave = () => this.peerLost('PEER DISCONNECTED');
    t.onRoomFull = () => this.fail('ROOM FULL');
    t.onMessage = (bytes) => this.onMessage(bytes);
    t.onRemoteTrack = (track, stream) => this.emit('remotetrack', track, stream);
  }

  linkUp() {
    clearTimeout(this.timeout);
    this.linkedAt = performance.now();
    this.receiver.reset();
    this.resetNet();
    this.peerName = '';
    this.poller = setInterval(() => this.pollStats(), STATS_POLL_MS);
    this.setStatus('linked', `${Math.round(this.linkedAt - this.startedAt)} ms`);
    this.send(encodeKeyRequest());
  }

  onHello(h) {
    this.peerName = h.name || 'PEER';
    if (h.version !== PROTOCOL_VERSION) {
      this.fail(`PROTOCOL MISMATCH (v${h.version} vs v${PROTOCOL_VERSION})`);
      return;
    }
    this.emit('hello', h);
  }

  onMessage(bytes) {
    this.payload.recv += bytes.length;
    if (bytes[0] === MSG_KEY_REQUEST) this.emit('keyrequest');
    else if (bytes[0] === MSG_BYE) this.peerLost('PEER DISCONNECTED');
    else this.receiver.receive(bytes);
  }

  send(bytes) {
    if (!this.linked || !this.transport) return;
    this.payload.sent += bytes.length;
    this.transport.send(bytes);
  }

  peerLost(reason) {
    if (this.status !== 'linked') return;
    clearInterval(this.poller);
    this.poller = null;
    this.stopCompare();
    this.setStatus('lost', reason);
  }

  fail(reason) {
    if (this.status === 'solo') return;
    const info = this.diagnose();
    this.close(false);
    this.failInfo = info;
    this.setStatus('failed', reason);
  }

  resumeHosting() {
    this.receiver.reset();
    this.peerName = '';
    this.setStatus('hosting');
  }

  close(sendBye = true) {
    if (sendBye && this.linked) this.send(encodeBye());
    this.stopCompare();
    const t = this.transport;
    this.transport = null;
    if (t) Promise.resolve(t.close()).catch(() => {});
    this.reset();
  }

  disconnect() {
    this.close(true);
    this.setStatus('solo');
  }

  // Real-video comparison
  setCompare(on, track, stream) {
    if (!this.linked || !this.transport) return;
    if (on && !this.comparing) {
      this.transport.addVideoTrack(track, stream);
      this.compareTrack = track;
      this.comparing = true;
    } else if (!on) {
      this.stopCompare();
    }
  }

  stopCompare() {
    if (!this.comparing) return;
    this.comparing = false;
    if (this.transport) this.transport.removeVideoTrack(this.compareTrack);
    this.compareTrack = null;
  }

  // Network stats
  async pollStats() {
    const pc = this.transport?.getPeerConnection();
    if (!pc) return;
    let report;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    const label = this.transport?.dataChannelLabel;
    const cur = { t: performance.now(), dcSent: 0, dcRecv: 0, videoSent: 0, videoRecv: 0, hasDc: false };
    report.forEach((s) => {
      if (s.type === 'data-channel' && (!label || s.label === label)) {
        cur.dcSent += s.bytesSent ?? 0;
        cur.dcRecv += s.bytesReceived ?? 0;
        cur.hasDc = cur.hasDc || s.bytesSent !== undefined;
      } else if (s.type === 'outbound-rtp' && s.kind === 'video') {
        cur.videoSent += (s.bytesSent ?? 0) + (s.headerBytesSent ?? 0);
      } else if (s.type === 'inbound-rtp' && s.kind === 'video') {
        cur.videoRecv += (s.bytesReceived ?? 0) + (s.headerBytesReceived ?? 0);
      }
    });
    cur.paySent = this.payload.sent;
    cur.payRecv = this.payload.recv;
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return;
    const kbps = (key) => Math.max(0, cur[key] - prev[key]) * 8 / (cur.t - prev.t);
    this.net = {
      dcSent: kbps('dcSent'),
      dcRecv: kbps('dcRecv'),
      paySent: kbps('paySent'),
      payRecv: kbps('payRecv'),
      videoSent: kbps('videoSent'),
      videoRecv: kbps('videoRecv'),
      hasDcStats: cur.hasDc,
    };
    this.history.push({ ascii: cur.hasDc ? this.net.dcSent : this.net.paySent, video: this.net.videoSent, comparing: this.comparing });
    if (this.history.length > GRAPH_WINDOW_S * 1000 / STATS_POLL_MS) this.history.shift();
    this.emit('netstats', this.net);
  }
}
