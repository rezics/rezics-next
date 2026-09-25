import { expect, test } from 'bun:test';
import { createConnection, type Socket } from 'node:net';
import { Elysia } from 'elysia';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('HTTP lifecycle probe timed out')), 2_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port });
  await within(new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  }));
  return socket;
}

function gatedResponse(gate: Promise<void>, sent: { value: boolean }): Response {
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      await gate;
      try {
        controller.enqueue(new TextEncoder().encode('sensitive-result'));
        sent.value = true;
        controller.close();
      } catch { /* a disconnected client can cancel before the barrier opens */ }
    },
  }), { headers: { 'content-type': 'text/plain' } });
}

test('SEARCH12: Elysia afterResponse runs before a slow client receives a gated body', async () => {
  const gate = deferred<void>();
  const afterResponse = deferred<void>();
  const sent = { value: false };
  const app = new Elysia()
    .afterResponse(() => { afterResponse.resolve(); })
    .get('/probe', () => gatedResponse(gate.promise, sent));
  app.listen({ hostname: '127.0.0.1', port: 0 });
  const socket = await connect(app.server!.port!);
  try {
    const received = new Promise<string>((resolve, reject) => {
      let bytes = '';
      socket.on('data', chunk => { bytes += chunk.toString(); });
      socket.once('end', () => resolve(bytes));
      socket.once('error', reject);
    });
    socket.pause();
    socket.write('GET /probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await within(afterResponse.promise);
    expect(sent.value).toBe(false);
    // A second replica would wrongly observe zero pending reads if this hook
    // were used to finish the durable lease and then acknowledge strong close.
    gate.resolve();
    socket.resume();
    expect(await within(received)).toContain('sensitive-result');
  } finally {
    gate.resolve();
    socket.destroy();
    await app.stop();
  }
});

test('SEARCH12: Elysia afterResponse also precedes a disconnected client', async () => {
  const gate = deferred<void>();
  const afterResponse = deferred<void>();
  const sent = { value: false };
  const app = new Elysia()
    .afterResponse(() => { afterResponse.resolve(); })
    .get('/probe', () => gatedResponse(gate.promise, sent));
  app.listen({ hostname: '127.0.0.1', port: 0 });
  const socket = await connect(app.server!.port!);
  try {
    const closed = new Promise<void>(resolve => { socket.once('close', () => resolve()); });
    socket.write('GET /probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await within(afterResponse.promise);
    expect(sent.value).toBe(false);
    socket.destroy();
    await within(closed);
    expect(sent.value).toBe(false);
  } finally {
    gate.resolve();
    socket.destroy();
    await app.stop();
  }
});
