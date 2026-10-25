import { expect, test } from 'bun:test';
import { createImportFetch, MAX_IMPORT_ATTEMPTS, MAX_IMPORT_BODY_BYTES } from '../src/import-fetch.ts';

const origin = 'https://api.example.test';
const url = origin + '/v1/subjects:batchWrite?mode=one';
const payload = new Uint8Array(256).fill(32);
payload.set(new TextEncoder().encode(' { "commands" : [{ "key": "stable", "futureField": "雪" }] }\n'));
const scales = [1, 8, 64];
const headers = { 'idempotency-key': '"stable-request"', 'content-type': 'application/json', 'x-client': 'keep' };

// One deterministic producer partitions a fixed payload, never a catalogue/history workload.
function source(chunks: number, backingBytes = 512, offendingAt = -1, empty = false) {
  const observed = { pulls: 0, cancels: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const index = observed.pulls++;
        if (index === chunks) return controller.close();
        const length = empty ? 0 : payload.byteLength / chunks;
        // Allocation belongs to the producer; admission happens after the boundary pull.
        const backing = new ArrayBuffer(index === offendingAt ? MAX_IMPORT_BODY_BYTES + 1 : backingBytes);
        const chunk = new Uint8Array(backing, 8, length);
        chunk.set(payload.subarray(index * length, (index + 1) * length));
        controller.enqueue(chunk);
      },
      cancel() {
        observed.cancels++;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, observed };
}

function client(maxBodyBytes = payload.byteLength, retry = false, expected = payload) {
  const observed = { tokens: 0, fetches: 0, bytes: 0, waits: [] as number[] };
  const fetch = createImportFetch({
    origin,
    maxBodyBytes,
    maxAttempts: MAX_IMPORT_ATTEMPTS,
    token: async () => {
      observed.tokens++;
      return 'ordinary-token';
    },
    sleep: async (ms) => {
      observed.waits.push(ms);
    },
    fetch: (async (input, init) => {
      observed.fetches++;
      const request = new Request(input, init);
      const bytes = new Uint8Array(await request.arrayBuffer());
      observed.bytes += bytes.byteLength;
      expect(bytes).toEqual(expected);
      expect(request.url).toBe(url);
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('manual');
      expect([...request.headers]).toEqual([
        ['authorization', 'Bearer ordinary-token'],
        ['content-type', headers['content-type']],
        ['idempotency-key', headers['idempotency-key']],
        ['x-client', headers['x-client']],
      ]);
      if (retry && observed.fetches === 1) throw new TypeError('lost response');
      return new Response(null, { status: retry && observed.fetches < MAX_IMPORT_ATTEMPTS ? 503 : 200 });
    }) as typeof fetch,
  });
  return { fetch, observed };
}

function send(fetch: typeof globalThis.fetch, body: ReadableStream<Uint8Array>, suppliedRequest: boolean) {
  const init = { method: 'POST', body, headers };
  return suppliedRequest ? fetch(new Request(url, init)) : fetch(url, init);
}

// Code evidence: readBody checks full backing and remaining visible capacity before
// bytes.set. Its single owned Uint8Array grows geometrically with Math.min(limit, ...),
// so each old/new buffer is <= limit, their overlap <= 2 * limit, and copying is O(M).
// It retains no chunk list. These boundary/effect checks do not claim to measure heap.
test('fixed visible bytes survive 1/8/64 chunks and five exact adapter attempts at both entrypoints', async () => {
  expect(MAX_IMPORT_BODY_BYTES).toBe(2097152);
  expect(MAX_IMPORT_ATTEMPTS).toBe(5);
  for (const chunks of scales) {
    for (const suppliedRequest of [false, true]) {
      const { body, observed: producer } = source(chunks);
      const { fetch, observed } = client(payload.byteLength, true);
      expect((await send(fetch, body, suppliedRequest)).status).toBe(200);
      expect(producer).toEqual({ pulls: chunks + 1, cancels: 0 });
      expect(body.locked).toBe(false);
      expect(observed).toEqual({
        tokens: 1,
        fetches: 5,
        bytes: 5 * payload.byteLength,
        waits: [1000, 2000, 4000, 8000],
      });
    }
  }
});

test('oversized backing stops at the first offending pull, including empty views and later chunks', async () => {
  for (const chunks of scales) {
    for (const suppliedRequest of [false, true]) {
      for (const offendingAt of new Set([0, Math.floor(chunks / 2), chunks - 1])) {
        for (const empty of [false, true]) {
          const { body, observed: producer } = source(chunks, 512, offendingAt, empty);
          const { fetch, observed } = client();
          await expect(send(fetch, body, suppliedRequest)).rejects.toThrow(
            new RangeError('Import request body exceeds maxBodyBytes'),
          );
          expect(producer).toEqual({ pulls: offendingAt + 1, cancels: 1 });
          expect(body.locked).toBe(false);
          expect(observed).toEqual({ tokens: 0, fetches: 0, bytes: 0, waits: [] });
        }
      }
    }
  }
});

test('visible limit rejects one byte over at every scale without a tail pull or HTTP effects', async () => {
  for (const chunks of scales) {
    for (const suppliedRequest of [false, true]) {
      const { body, observed: producer } = source(chunks);
      const { fetch, observed } = client(payload.byteLength - 1);
      await expect(send(fetch, body, suppliedRequest)).rejects.toBeInstanceOf(RangeError);
      expect(producer).toEqual({ pulls: chunks, cancels: 1 });
      expect(body.locked).toBe(false);
      expect(observed).toEqual({ tokens: 0, fetches: 0, bytes: 0, waits: [] });
    }
  }
});

test('exact hard backing is admitted independently of a smaller configured visible limit', async () => {
  for (const suppliedRequest of [false, true]) {
    const { body, observed: producer } = source(1, MAX_IMPORT_BODY_BYTES);
    const { fetch, observed } = client();
    expect((await send(fetch, body, suppliedRequest)).status).toBe(200);
    expect(producer).toEqual({ pulls: 2, cancels: 0 });
    expect(body.locked).toBe(false);
    expect(observed).toEqual({ tokens: 1, fetches: 1, bytes: payload.byteLength, waits: [] });
  }
});

test('direct ArrayBuffer and views enforce hard backing and configured visible bytes', async () => {
  for (const hard of [MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BODY_BYTES + 1]) {
    const backing = new ArrayBuffer(hard);
    new Uint8Array(backing, 8, payload.byteLength).set(payload);
    for (const body of [
      backing,
      new Uint8Array(backing, 8, payload.byteLength),
      new DataView(backing, 8, payload.byteLength),
      new Uint16Array(backing, 8, payload.byteLength / 2),
      new Uint8Array(backing, 8, 0),
    ]) {
      const expected = body.byteLength === 0 ? new Uint8Array(0) : payload;
      const { fetch, observed } = client(expected.byteLength, false, expected);
      if (hard > MAX_IMPORT_BODY_BYTES || body === backing) {
        await expect(fetch(url, { method: 'POST', headers, body })).rejects.toBeInstanceOf(RangeError);
        expect(observed).toEqual({ tokens: 0, fetches: 0, bytes: 0, waits: [] });
      } else {
        expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
        expect(observed).toEqual({ tokens: 1, fetches: 1, bytes: expected.byteLength, waits: [] });
        if (expected.byteLength > 0) {
          const smaller = client(payload.byteLength - 1);
          await expect(smaller.fetch(url, { method: 'POST', headers, body })).rejects.toBeInstanceOf(RangeError);
          expect(smaller.observed).toEqual({ tokens: 0, fetches: 0, bytes: 0, waits: [] });
        }
      }
    }
  }
});

test('other supported BodyInit objects keep native semantics without reading a buffer property', async () => {
  const form = new FormData();
  form.set('message', '雪');
  form.set('file', new Blob(['contents']), 'sample.txt');
  const text = '雪';
  const params = new URLSearchParams({ message: text });
  const blob = new Blob([text], { type: 'text/plain' });
  for (const body of [text, params, blob, form]) {
    if (typeof body !== 'string') {
      Object.defineProperty(body, 'buffer', {
        get() {
          throw new Error('unrelated buffer property');
        },
      });
    }
    let tokens = 0;
    let fetches = 0;
    const fetch = createImportFetch({
      origin,
      token: async () => {
        tokens++;
        return 'ordinary-token';
      },
      fetch: (async (input, init) => {
        fetches++;
        const request = new Request(input, init);
        if (body === form) {
          const received = await request.formData();
          expect(received.get('message')).toBe(text);
          const file = received.get('file') as File;
          expect(file.name).toBe('sample.txt');
          expect(await file.text()).toBe('contents');
        } else expect(await request.text()).toBe(body === params ? params.toString() : text);
        return new Response();
      }) as typeof fetch,
    });
    expect((await fetch(url, { method: 'POST', body })).status).toBe(200);
    expect([tokens, fetches]).toEqual([1, 1]);
  }
});
