import { openRoomTransport } from './transport-room.js';
import { ManualTransport } from './transport-manual.js';

export function createTransport(kind, options = {}) {
  if (kind === 'room') return openRoomTransport(options);
  return Promise.resolve(new ManualTransport());
}
