import { expect, test } from 'bun:test';
import { Socket } from 'node:net';
import { ownBridgeSocket } from './native/private-browser-socket.ts';

test('a closing private bridge connection owns its asynchronous Socket is closed error', async () => {
  const socket = new Socket();
  ownBridgeSocket(socket);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.end('queued bridge response');
  await closed;
  expect(socket.destroyed).toBe(true);
});

test('a bridge peer reset retires that connection and leaves unrelated socket listeners intact', () => {
  const socket = new Socket();
  ownBridgeSocket(socket);
  let observed = false;
  socket.on('error', () => {
    observed = true;
  });
  socket.emit('error', new Error('peer reset'));
  expect(observed).toBe(true);
  expect(socket.destroyed).toBe(true);
});
