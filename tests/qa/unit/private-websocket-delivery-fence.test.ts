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

type Frame = { fin: boolean; opcode: number; payload: Buffer };

async function rawClient(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const upgraded = deferred<void>();
  const waiting: Array<(frame: Frame) => void> = [];
  const frames: Frame[] = [];
  let buffer = Buffer.alloc(0);
  let upgradeComplete = false;
  let dataEvents = 0;
  socket.on('data', chunk => {
    dataEvents++;
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
      const width = buffer[1]! & 0x7f;
      const header = width === 126 ? 4 : width === 127 ? 10 : 2;
      if (buffer.length < header) return;
      if (buffer[1]! & 0x80) throw new Error('masked server frame');
      const length = width === 126 ? buffer.readUInt16BE(2)
        : width === 127 ? Number(buffer.readBigUInt64BE(2)) : width;
      if (!Number.isSafeInteger(length) || length > 1_048_576) throw new Error('oversize probe frame');
      if (buffer.length < header + length) return;
      const frame = { fin: !!(buffer[0]! & 0x80), opcode: buffer[0]! & 0x0f,
        payload: buffer.subarray(header, header + length) };
      buffer = buffer.subarray(header + length);
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
    dataEvents: () => dataEvents,
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
  const pongs: string[] = [];
  const pongWaiters: Array<(value: string) => void> = [];
  const closed = deferred<void>();
  const app = new Elysia().use(websocket({ sendPings: false })).ws('/delivery-probe', {
    open(ws) { opened.resolve(ws); },
    message() {},
    pong(_ws, data) {
      const value = Buffer.from(data).toString();
      const waiter = pongWaiters.shift();
      if (waiter) waiter(value);
      else pongs.push(value);
    },
    close() { closed.resolve(); },
  });
  app.listen({ hostname: '127.0.0.1', port: 0 });
  return { app, opened: opened.promise,
    nextPong: () => within(pongs.length ? Promise.resolve(pongs.shift()!)
      : new Promise<string>(resolve => pongWaiters.push(resolve))),
    pongs, closed: closed.promise };
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
    expect(await server.nextPong()).toBe(nonce);
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
    expect(server.pongs).toHaveLength(0);
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

test('SEARCH12: a paused peer receives the entire 1 MiB result before the receipt ping', async () => {
  const server = probeServer();
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(server.app.server!.port!);
    const ws = await within(server.opened);
    const result = 'x'.repeat(1_048_576);
    const nonce = randomBytes(16).toString('hex');
    const priorDataEvents = client.dataEvents();
    client.socket.pause();
    const sendStatus = ws.send(result);
    const pingStatus = ws.ping(nonce);
    expect(sendStatus).not.toBe(0);
    expect(pingStatus).not.toBe(0);
    expect(server.pongs).toHaveLength(0);
    client.pong(Buffer.from('forged-before-reading-result'));
    expect(await server.nextPong()).toBe('forged-before-reading-result');
    expect(client.dataEvents()).toBe(priorDataEvents);
    client.socket.resume();

    const chunks: Buffer[] = [];
    let resultComplete = false;
    let fragmentCount = 0;
    for (;;) {
      const frame = await client.nextFrame();
      if (frame.opcode === 9) {
        expect(resultComplete).toBe(true);
        expect(frame.payload.toString()).toBe(nonce);
        client.pong(frame.payload);
        break;
      }
      expect(frame.opcode).toBe(fragmentCount === 0 ? 1 : 0);
      expect(resultComplete).toBe(false);
      chunks.push(frame.payload);
      fragmentCount++;
      resultComplete = frame.fin;
    }
    expect(fragmentCount).toBe(1);
    expect(client.dataEvents()).toBeGreaterThan(priorDataEvents);
    expect(Buffer.concat(chunks).toString()).toBe(result);
    expect(await server.nextPong()).toBe(nonce);
  } finally {
    client?.socket.destroy();
    await server.app.stop();
  }
});

test('SEARCH12: Elysia reports unsolicited and early pongs before any result frame', async () => {
  const server = probeServer();
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(server.app.server!.port!);
    await within(server.opened);
    const guessedNonce = randomBytes(16).toString('hex');
    client.pong(Buffer.from(guessedNonce));
    expect(await server.nextPong()).toBe(guessedNonce);
    // A pong callback alone is not a receipt. A candidate must bind a fresh
    // nonce to this lease and ignore callbacks before its result and ping send.
  } finally {
    client?.socket.destroy();
    await server.app.stop();
  }
});

test('SEARCH12: close does not revoke a paused peer’s buffered 1 MiB result', async () => {
  const server = probeServer();
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(server.app.server!.port!);
    const ws = await within(server.opened);
    client.socket.pause();
    expect(ws.send('x'.repeat(1_048_576))).not.toBe(0);
    client.socket.end();
    await within(server.closed);
    client.socket.resume();
    const frame = await client.nextFrame();
    expect(frame.opcode).toBe(1);
    expect(frame.fin).toBe(true);
    expect(frame.payload.length).toBe(1_048_576);
  } finally {
    client?.socket.destroy();
    await server.app.stop();
  }
});
