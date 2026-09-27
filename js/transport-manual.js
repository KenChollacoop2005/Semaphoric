const STUN_URLS = ['stun:stun.l.google.com:19302'];
const ICE_GATHER_TIMEOUT_MS = 5000;
export const FRAMES_LABEL = 'frames';
const SIGNAL_LABEL = 'signal';
const OFFER_PREFIX = 'o';
const ANSWER_PREFIX = 'a';

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// SDP to compact code: deflate + base64url
export async function encodeSignal(desc) {
  const text = (desc.type === 'offer' ? OFFER_PREFIX : ANSWER_PREFIX) + desc.sdp;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function decodeSignal(code) {
  try {
    const bytes = fromBase64Url(code.replace(/\s+/g, ''));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const text = await new Response(stream).text();
    const type = text[0] === OFFER_PREFIX ? 'offer' : text[0] === ANSWER_PREFIX ? 'answer' : null;
    if (!type) throw new Error('unknown prefix');
    return { type, sdp: text.slice(1) };
  } catch {
    throw new Error('INVALID CODE');
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// Raw RTCPeerConnection; copy-paste signaling, then in-band renegotiation
export class ManualTransport {
  constructor() {
    this.kind = 'manual';
    this.dataChannelLabel = FRAMES_LABEL;
    this.onMessage = null;
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    this.onRemoteTrack = null;
    this.frames = null;
    this.signal = null;
    this.open = false;
    this.closed = false;
    this.polite = false;
    this.makingOffer = false;
    this.videoSender = null;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] });
    this.pc = pc;
    pc.ondatachannel = (e) => this.bindChannel(e.channel);
    pc.ontrack = (e) => {
      if (this.onRemoteTrack) this.onRemoteTrack(e.track, e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.lost();
    };
    // Later track changes renegotiate over the signal channel
    pc.onnegotiationneeded = async () => {
      if (!this.open) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignal(pc.localDescription);
      } catch (err) {
        console.warn('renegotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };
  }

  bindChannel(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === FRAMES_LABEL) {
      this.frames = ch;
      ch.onmessage = (e) => { if (this.onMessage) this.onMessage(new Uint8Array(e.data)); };
    } else if (ch.label === SIGNAL_LABEL) {
      this.signal = ch;
      ch.onmessage = (e) => this.handleSignal(JSON.parse(e.data));
    }
    ch.onopen = () => this.checkOpen();
    ch.onclose = () => this.lost();
    this.checkOpen();
  }

  checkOpen() {
    if (this.open || this.frames?.readyState !== 'open' || this.signal?.readyState !== 'open') return;
    this.open = true;
    if (this.onPeerJoin) this.onPeerJoin();
  }

  lost() {
    if (this.closed || !this.open) return;
    this.open = false;
    if (this.onPeerLeave) this.onPeerLeave();
  }

  // Caller step 1
  async createOffer() {
    this.polite = false;
    this.bindChannel(this.pc.createDataChannel(FRAMES_LABEL));
    this.bindChannel(this.pc.createDataChannel(SIGNAL_LABEL));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    return encodeSignal(this.pc.localDescription);
  }

  // Caller step 2
  async acceptAnswer(code) {
    const desc = await decodeSignal(code);
    if (desc.type !== 'answer') throw new Error('THAT IS AN OFFER CODE, NOT AN ANSWER');
    await this.pc.setRemoteDescription(desc);
  }

  // Callee: offer in, answer out
  async acceptOffer(code) {
    this.polite = true;
    const desc = await decodeSignal(code);
    if (desc.type !== 'offer') throw new Error('THAT IS AN ANSWER CODE, NOT AN OFFER');
    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    return encodeSignal(this.pc.localDescription);
  }

  sendSignal(desc) {
    if (this.signal?.readyState === 'open') this.signal.send(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
  }

  // Perfect-negotiation style glare handling
  async handleSignal(desc) {
    const pc = this.pc;
    const collision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    if (collision && !this.polite) return;
    try {
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        this.sendSignal(pc.localDescription);
      }
    } catch (err) {
      console.warn('signal handling failed', err);
    }
  }

  send(bytes) {
    if (this.frames?.readyState === 'open') this.frames.send(bytes);
  }

  getPeerConnection() {
    return this.pc;
  }

  addVideoTrack(track, stream) {
    if (!this.videoSender) this.videoSender = this.pc.addTrack(track, stream);
  }

  removeVideoTrack() {
    if (!this.videoSender) return;
    this.pc.removeTrack(this.videoSender);
    this.videoSender = null;
  }

  close() {
    this.closed = true;
    this.open = false;
    this.frames?.close();
    this.signal?.close();
    this.pc.close();
  }
}
