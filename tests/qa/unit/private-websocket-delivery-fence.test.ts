import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WebSocket delivery probe timed out')), 2_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

type Frame = { opcode: number; payload: Buffer };

async function rawClient(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const upgraded = deferred<void>();
  const waiting: Array<(frame: Frame) => void> = [];
  const frames: Frame[] = [];
  let buffer = Buffer.alloc(0);
  let upgradeComplete = false;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgradeComplete) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      expect(buffer.subarray(0, end).toString()).toContain('101 Switching Protocols');
      buffer = buffer.subarray(end + 4);
      upgradeComplete = true;
      upgraded.resolve();
    }
    while (buffer.length >= 2) {
      const length = buffer[1]! & 0x7f;
      // The bounded probe sends only short, unmasked server frames.
      if (length >= 126 || (buffer[1]! & 0x80)) throw new Error('unexpected probe frame');
      if (buffer.length < 2 + length) return;
      const frame = { opcode: buffer[0]! & 0x0f, payload: buffer.subarray(2, 2 + length) };
      buffer = buffer.subarray(2 + length);
      const waiter = waiting.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  await within(new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  }));
  socket.write(`GET /delivery-probe HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await within(upgraded.promise);
  return {
    socket,
    nextFrame: () => within(frames.length ? Promise.resolve(frames.shift()!) : new Promise<Frame>(resolve => waiting.push(resolve))),
    pong(payload: Buffer) {
      const mask = randomBytes(4);
      const frame = Buffer.alloc(2 + mask.length + payload.length);
      frame[0] = 0x8a;
      frame[1] = 0x80 | payload.length;
      mask.copy(frame, 2);
      for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i]! ^ mask[i % 4]!;
      socket.write(frame);
    },
  };
}

function probeServer() {
  const opened = deferred<{ send(data: string): number; ping(data: string): number }>();
  const pong = deferred<string>();
  const closed = deferred<void>();
  const app = new Elysia().use(websocket({ sendPings: false })).ws('/delivery-probe', {
    open(ws) { opened.resolve(ws); },
    message() {},
    pong(_ws, data) { pong.resolve(Buffer.from(data).toString()); },
    close() { closed.resolve(); },
  });
  app.listen({ hostname: '127.0.0.1', port: 0 });
  return { app, opened: opened.promise, pong: pong.promise, closed: closed.promise };
}

test('SEARCH12: matching pong follows result bytes, while send statuses precede observed pong', async () => {
  const server = probeServer();
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(server.app.server!.port!);
    const ws = await within(server.opened);
    client.socket.pause();
    const nonce = randomBytes(12).toString('hex');
    const sendStatus = ws.send('sensitive-result');
    const pingStatus = ws.ping(nonce);
    expect(sendStatus).toBeGreaterThan(0);
    expect(pingStatus).toBeGreaterThan(0);
    // The client has not read frames or answered the ping; status values cannot
    // finish the Access lease, even when they report positive byte counts.
    client.socket.resume();
    const result = await client.nextFrame();
    const ping = await client.nextFrame();
    expect(result.opcode).toBe(1);
    expect(result.payload.toString()).toBe('sensitive-result');
    expect(ping.opcode).toBe(9);
    expect(ping.payload.toString()).toBe(nonce);
    client.pong(ping.payload);
    expect(await within(server.pong)).toBe(nonce);
  } finally {
    client?.socket.destroy();
    await server.app.stop();
  }
});

test('SEARCH12: a disconnected client yields close without a matching pong', async () => {
  const server = probeServer();
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(server.app.server!.port!);
    const ws = await within(server.opened);
    client.socket.pause();
    expect(ws.send('sensitive-result')).toBeGreaterThan(0);
    expect(ws.ping(randomBytes(12).toString('hex'))).toBeGreaterThan(0);
    client.socket.destroy();
    await within(server.closed);
    // close is an abort signal; it gives no receipt for already queued bytes.
    let receivedPong = false;
    void server.pong.then(() => { receivedPong = true; });
    await Promise.resolve();
    expect(receivedPong).toBe(false);
  } finally {
    client?.socket.destroy();
    await server.app.stop();
  }
});

test('SEARCH12: TCP half-close can report server close before buffered result is read', async () => {
  const server = probeServer();
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(server.app.server!.port!);
    const ws = await within(server.opened);
    client.socket.pause();
    expect(ws.send('sensitive-result')).toBeGreaterThan(0);
    client.socket.end();
    await within(server.closed);
    client.socket.resume();
    const result = await client.nextFrame();
    expect(result.opcode).toBe(1);
    expect(result.payload.toString()).toBe('sensitive-result');
  } finally {
    client?.socket.destroy();
    await server.app.stop();
  }
});
