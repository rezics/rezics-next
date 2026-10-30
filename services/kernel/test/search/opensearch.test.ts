import { expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { createOpenSearch, OpenSearchError, SearchUnavailableError } from '../../src/search/opensearch.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const native = createOpenSearch(url);
const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

async function rootBytes() {
  const response = await fetch(url!);
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

// Successful replies always originate at the real engine. Only failures and wire schedules are injected.
async function forward(request: Request) {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, url);
  return fetch(target, {
    method: request.method,
    headers: request.headers,
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.text() }),
    signal: request.signal,
  });
}

async function withServer(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (address: string) => Promise<void>,
) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  try {
    await run(server.url.toString());
  } finally {
    await server.stop(true);
  }
}

function chunked(bytes: Uint8Array, sizes: readonly number[], headers?: HeadersInit, status = 200) {
  let offset = 0;
  let chunk = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(bytes.length, offset + sizes[chunk++ % sizes.length]!);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        // Separate native HTTP writes rather than only splitting an in-memory decoder input.
        await Bun.sleep(1);
      },
    }),
    { status, ...(headers === undefined ? {} : { headers }) },
  );
}

async function unavailable(operation: Promise<unknown>) {
  const error: unknown = await operation.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(SearchUnavailableError);
  expect(error).not.toBeInstanceOf(OpenSearchError);
  expect(error).not.toHaveProperty('body');
  expect(error).not.toHaveProperty('cause');
  return error as SearchUnavailableError;
}

async function recovered(client: ReturnType<typeof createOpenSearch>) {
  const result = await client.request<{ version: { number: string } }>('GET', '/');
  expect(result.status).toBe(200);
  expect(result.body.version.number).toMatch(/^3\./);
}

test('actual UTF-8 bytes are counted across HTTP chunks, including split multibyte characters and exact boundaries', async () => {
  // Native document data gives the positive payload multibyte content without a fake success engine.
  const index = `test-transport-utf8-${crypto.randomUUID()}`;
  await native.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
  try {
    await native.request('PUT', `/${index}/_doc/a`, { label: '水🙂é' });
    const response = await fetch(new URL(`/${index}/_doc/a`, url));
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain('水🙂é');
    expect(bytes.length).toBeGreaterThan(new TextDecoder().decode(bytes).length);
    await withServer(
      (request) => (new URL(request.url).pathname === '/wire' ? chunked(bytes, [1, 2, 5, 17]) : forward(request)),
      async (address) => {
        const exact = createOpenSearch(address, { maxResponseBytes: bytes.length });
        expect((await exact.request('GET', '/wire')).body).toMatchObject({ _source: { label: '水🙂é' } });
        await unavailable(createOpenSearch(address, { maxResponseBytes: bytes.length - 1 }).request('GET', '/wire'));
      },
    );
  } finally {
    await native.request('DELETE', `/${index}`);
  }
});

test('the production 4 MiB budget accepts exact bytes and rejects boundary plus one without a length', async () => {
  const root = await rootBytes();
  const exact = new Uint8Array(MAX_BYTES).fill(32);
  exact.set(root);
  const over = new Uint8Array(MAX_BYTES + 1).fill(32);
  over.set(root);
  await withServer(
    (request) => {
      switch (new URL(request.url).pathname) {
        case '/exact':
          return chunked(exact, [65535, 1, 131072]);
        case '/over':
          return chunked(over, [65535, 1, 131072]);
        default:
          return forward(request);
      }
    },
    async (address) => {
      const client = createOpenSearch(address);
      expect((await client.request('GET', '/exact')).body).toEqual(JSON.parse(new TextDecoder().decode(root)));
      await unavailable(client.request('GET', '/over'));
      await recovered(client);
    },
  );
});

test('an oversized never-ending producer is cancelled before EOF and the same client recovers', async () => {
  let produced = 0;
  const cancelled = Promise.withResolvers<void>();
  await withServer(
    (request) => {
      if (new URL(request.url).pathname !== '/endless') return forward(request);
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            produced += 1024;
            controller.enqueue(new Uint8Array(1024).fill(32));
            await Bun.sleep(5);
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      );
    },
    async (address) => {
      const client = createOpenSearch(address, { maxResponseBytes: 4096 });
      await unavailable(client.request('GET', '/endless'));
      await cancelled.promise;
      expect(produced).toBeGreaterThan(4096);
      const stoppedAt = produced;
      await recovered(client);
      expect(produced).toBe(stoppedAt);
    },
  );
});

test('an honest oversized Content-Length refuses at headers and cancels a body that never sends bytes', async () => {
  const cancelled = Promise.withResolvers<void>();
  await withServer(
    (request) =>
      new URL(request.url).pathname === '/large'
        ? new Response(
            new ReadableStream({
              cancel() {
                cancelled.resolve();
              },
            }),
            { headers: { 'content-length': String(MAX_BYTES + 1) } },
          )
        : forward(request),
    async (address) => {
      const client = createOpenSearch(address, { timeoutMs: 2000 });
      const error = await unavailable(client.request('GET', '/large'));
      expect(error.message).not.toContain('timed out');
      await cancelled.promise;
      await recovered(client);
    },
  );
});

// Raw HTTP is necessary for conflicting/invalid lengths, truncated framing and peer disconnects.
async function withWire(write: (socket: Socket) => void, run: (address: string) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => write(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('lying, invalid and missing lengths cannot waive observed bytes or accept partial native JSON', async () => {
  const nativeBody = new TextDecoder().decode(await rootBytes());
  const tooLarge = nativeBody + ' '.repeat(2048);
  const schedules = [
    // A compliant HTTP parser may reject the conflicting framing before exposing a body; either way it must fail.
    `Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n${tooLarge.length.toString(16)}\r\n${tooLarge}\r\n0\r\n\r\n`,
    `Content-Length: nonsense\r\n\r\n${tooLarge}`,
    `Content-Length: 1\r\n\r\n${nativeBody}`,
    `Content-Length: ${nativeBody.length + 100}\r\n\r\n${nativeBody}`,
    `\r\n${tooLarge}`,
  ];
  for (const wire of schedules) {
    await withWire(
      (socket) => socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n${wire}`),
      async (address) => {
        const client = createOpenSearch(address, { maxResponseBytes: 1024 });
        await unavailable(client.request('GET', '/'));
        // Independent absolute native request uses the same adapter after the failed wire exchange.
        await recovered(createOpenSearch(url!));
      },
    );
  }
});

test('timeout remains active after headers and after partial body bytes and releases each producer', async () => {
  for (const partial of [false, true]) {
    const cancelled = Promise.withResolvers<void>();
    await withServer(
      (request) =>
        new URL(request.url).pathname === '/slow'
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  if (partial) controller.enqueue(encoder.encode('{"waiting":'));
                },
                cancel() {
                  cancelled.resolve();
                },
              }),
            )
          : forward(request),
      async (address) => {
        const client = createOpenSearch(address);
        const error = await unavailable(client.request('GET', '/slow', undefined, { timeoutMs: 100 }));
        expect(error.message).toContain('timed out');
        await cancelled.promise;
        await recovered(client);
      },
    );
  }
});

test('abort from the HTTP peer during body consumption is unavailable and a subsequent connection recovers', async () => {
  let calls = 0;
  const root = await rootBytes();
  await withWire(
    (socket) => {
      calls++;
      if (calls === 1) {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n{"partial":');
        setTimeout(() => socket.destroy(), 10);
      } else {
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${root.length}\r\nConnection: close\r\n\r\n${new TextDecoder().decode(root)}`,
        );
      }
    },
    async (address) => {
      const client = createOpenSearch(address);
      await unavailable(client.request('GET', '/'));
      await recovered(client);
      expect(calls).toBe(2);
    },
  );
});

test('successful malformed or truncated JSON fails closed without retaining the response payload', async () => {
  const payloads = ['private-wire-payload', '{"partial":', '{"valid":true} trailing-private-wire-payload'];
  await withServer(
    (request) => {
      const match = new URL(request.url).pathname.match(/^\/bad\/(\d)$/);
      return match ? chunked(encoder.encode(payloads[Number(match[1])]!), [1, 7]) : forward(request);
    },
    async (address) => {
      const client = createOpenSearch(address);
      for (const n of payloads.keys()) {
        const error = await unavailable(client.request('GET', `/bad/${n}`));
        expect(String(error)).not.toContain(payloads[n]!);
        await recovered(client);
      }
    },
  );
});

test('bounded native 4xx diagnostics survive while oversized errors and gateway outages stay unavailable', async () => {
  const missing = `test-transport-missing-${crypto.randomUUID()}`;
  await withServer(
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/oversized-error')
        return chunked(
          encoder.encode(
            JSON.stringify({
              error: { type: 'private_error', reason: 'private-wire-payload'.repeat(1024) },
            }),
          ),
          [127, 1024],
          undefined,
          400,
        );
      if (/^\/gateway\//.test(path))
        return new Response('private-wire-payload', { status: Number(path.split('/')[2]) });
      if (path === '/plain-error') return new Response('private-wire-payload', { status: 400 });
      return forward(request);
    },
    async (address) => {
      const client = createOpenSearch(address, { maxResponseBytes: 4096 });
      const error: unknown = await client.request('GET', `/${missing}/_search`).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(OpenSearchError);
      expect(error).toMatchObject({ status: 404, type: 'index_not_found_exception' });
      expect((error as OpenSearchError).body).toMatchObject({ error: { type: 'index_not_found_exception' } });
      expect(String(error)).not.toContain(missing);
      const plain: unknown = await client.request('GET', '/plain-error').catch((error: unknown) => error);
      expect(plain).toBeInstanceOf(OpenSearchError);
      expect(String(plain)).not.toContain('private-wire-payload');
      expect((plain as OpenSearchError).body).toBeUndefined();
      await unavailable(client.request('GET', '/oversized-error'));
      for (const status of [502, 503, 504]) {
        const failure = await unavailable(client.request('GET', `/gateway/${status}`));
        expect(String(failure)).not.toContain('private-wire-payload');
      }
      await recovered(client);
    },
  );
});

test('configured credentials and native network errors never appear in an unavailable error or its cause', async () => {
  const client = createOpenSearch('http://configured-user:configured-password@127.0.0.1:9', { timeoutMs: 100 });
  const error = await unavailable(client.request('GET', '/private-path'));
  expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain('configured-user');
  expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain('configured-password');
});

test('internal lower budgets cannot increase or disable the production ceiling', () => {
  for (const maxResponseBytes of [0, -1, 0.5, NaN, Infinity, MAX_BYTES + 1]) {
    expect(() => createOpenSearch(url!, { maxResponseBytes })).toThrow(RangeError);
  }
});

test('real query, bulk, query parameters, native errors and HEAD semantics survive streamed transport', async () => {
  const index = `test-transport-roundtrip-${crypto.randomUUID()}`;
  const captures: { method: string; path: string; body: string; contentType: string | null }[] = [];
  await withServer(
    async (request) => {
      captures.push({
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        body: await request.clone().text(),
        contentType: request.headers.get('content-type'),
      });
      return forward(request);
    },
    async (address) => {
      const client = createOpenSearch(address);
      await client.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
      try {
        const lines = [
          { index: { _index: index, _id: 'a', version: 5, version_type: 'external' } },
          { name: '水 lantern' },
          { index: { _index: index, _id: 'a', version: 4, version_type: 'external' } },
          { name: 'older' },
        ];
        const bulk = await client.bulk<{ errors: boolean; items: { index: { status: number } }[] }>(lines, {
          query: { refresh: 'wait_for' },
        });
        expect(bulk.errors).toBe(true);
        expect(bulk.items.map((item) => item.index.status)).toEqual([201, 409]);
        expect(captures.at(-1)).toEqual({
          method: 'POST',
          path: '/_bulk?refresh=wait_for',
          body: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
          contentType: 'application/x-ndjson',
        });
        const query = { query: { match: { name: 'lantern' } }, size: 1 };
        const result = await client.request<{ hits: { hits: { _id: string; _source: { name: string } }[] } }>(
          'POST',
          `/${index}/_search`,
          query,
          { query: { track_total_hits: false, preference: 'wire & utf8 水' } },
        );
        expect(result.body.hits.hits).toMatchObject([{ _id: 'a', _source: { name: '水 lantern' } }]);
        expect(captures.at(-1)?.body).toBe(JSON.stringify(query));
        const params = new URL(`http://localhost${captures.at(-1)!.path}`).searchParams;
        expect(params.get('track_total_hits')).toBe('false');
        expect(params.get('preference')).toBe('wire & utf8 水');
        expect(await client.request('HEAD', `/${index}`, { ignored: true })).toEqual({ status: 200, body: undefined });
        const missing: unknown = await client.request('HEAD', `/${index}-missing`).catch((error: unknown) => error);
        expect(missing).toMatchObject({ status: 404, type: null, body: undefined });
        expect(missing).toBeInstanceOf(OpenSearchError);
        expect(captures.at(-1)?.body).toBe('');
      } finally {
        await client.request('DELETE', `/${index}`);
      }
    },
  );
});

test('streamed byte accounting and one native query stay fixed across three unrelated engine populations', async () => {
  const index = `test-transport-growth-${crypto.randomUUID()}`;
  await native.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
  try {
    await native.bulk([{ index: { _index: index, _id: 'selected' } }, { selected: true, label: '水🙂' }], {
      query: { refresh: 'wait_for' },
    });
    const observations: { requests: number; bytes: number }[] = [];
    let requests = 0;
    let bytes = 0;
    await withServer(
      async (request) => {
        requests++;
        const response = await forward(request);
        return new Response(
          response.body!.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
          ),
          { status: response.status },
        );
      },
      async (address) => {
        const client = createOpenSearch(address, { maxResponseBytes: 1024 });
        let previous = 0;
        for (const population of [0, 37, 211]) {
          if (population > previous) {
            const lines = Array.from({ length: population - previous }, (_, n) => [
              { index: { _index: index, _id: `unrelated-${n + previous}` } },
              { selected: false, padding: 'x'.repeat(128) },
            ]).flat();
            expect((await native.bulk<{ errors: boolean }>(lines, { query: { refresh: 'wait_for' } })).errors).toBe(
              false,
            );
          }
          previous = population;
          requests = 0;
          bytes = 0;
          const response = await client.request<{ hits: { hits: { _id: string }[] } }>(
            'POST',
            `/${index}/_search`,
            {
              query: { term: { selected: true } },
              size: 1,
            },
            { query: { filter_path: 'hits.hits._id,hits.hits._source' } },
          );
          expect(response.body.hits.hits).toMatchObject([
            { _id: 'selected', _source: { selected: true, label: '水🙂' } },
          ]);
          expect(bytes).toBe(encoder.encode(JSON.stringify(response.body)).length);
          observations.push({ requests, bytes });
        }
      },
    );
    expect(observations).toHaveLength(3);
    expect(observations).toEqual(Array.from({ length: 3 }, () => ({ requests: 1, bytes: observations[0]!.bytes })));
    expect(observations[0]!.bytes).toBeLessThan(1024);
  } finally {
    await native.request('DELETE', `/${index}`);
  }
});
