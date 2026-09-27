const TRYSTERO_URL = 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm';
export const APP_ID = 'semaphoric-v1';
const FRAME_ACTION = 'frame';
const CONTROL_ACTION = 'ctl';
const CTL_ACCEPT = 'accept';
const CTL_FULL = 'full';

// Trystero room, gated to exactly one peer
export async function openRoomTransport({ code, role }) {
  const { joinRoom } = await import(TRYSTERO_URL);
  const room = joinRoom({ appId: APP_ID }, code);
  const frames = room.makeAction(FRAME_ACTION);
  const control = room.makeAction(CONTROL_ACTION);
  let peerId = null;

  const t = {
    kind: 'room',
    dataChannelLabel: null,
    onMessage: null,
    onPeerJoin: null,
    onPeerLeave: null,
    onRoomFull: null,
    onRemoteTrack: null,

    send(bytes) {
      if (!peerId) return;
      frames.send(bytes, { target: peerId }).catch((err) => console.warn('room send failed', err));
    },

    getPeerConnection() {
      return peerId ? room.getPeers()[peerId] ?? null : null;
    },

    addVideoTrack(track, stream) {
      if (peerId) room.addTrack(track, stream, { target: peerId });
    },

    removeVideoTrack(track) {
      if (peerId) room.removeTrack(track, { target: peerId });
    },

    close() {
      peerId = null;
      return room.leave();
    },
  };

  const accept = (id) => {
    peerId = id;
    if (t.onPeerJoin) t.onPeerJoin();
  };

  // Host admits the first peer, turns away the rest
  room.onPeerJoin = (id) => {
    if (role !== 'host') return;
    if (peerId) {
      control.send(CTL_FULL, { target: id }).catch(() => {});
      return;
    }
    control.send(CTL_ACCEPT, { target: id }).catch(() => {});
    accept(id);
  };

  room.onPeerLeave = (id) => {
    if (id !== peerId) return;
    peerId = null;
    if (t.onPeerLeave) t.onPeerLeave();
  };

  // Joiner pairs only with the host that accepts it
  control.onMessage = (msg, { peerId: from }) => {
    if (role !== 'join' || peerId) return;
    if (msg === CTL_ACCEPT) accept(from);
    else if (msg === CTL_FULL && t.onRoomFull) t.onRoomFull();
  };

  frames.onMessage = (data, { peerId: from }) => {
    if (from !== peerId || !t.onMessage) return;
    t.onMessage(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  };

  room.onPeerTrack = (track, stream, id) => {
    if (id === peerId && t.onRemoteTrack) t.onRemoteTrack(track, stream);
  };

  return t;
}
