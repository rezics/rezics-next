import type { Socket } from 'node:net';

export const privateBrowserResponseBytes = 16 * 1024 * 1024;

/** Peer disconnects and teardown retire the bridge connection that owns the failed write. */
export function ownBridgeSocket(socket: Socket): void {
  socket.on('error', () => socket.destroy());
}
