import { openRoomTransport } from './transport-room.js';
import { ManualTransport } from './transport-manual.js';

// Room or manual; identical interface
export function createTransport(kind, options = {}) {
  if (kind === 'room') return openRoomTransport(options);
  return Promise.resolve(new ManualTransport());
}
