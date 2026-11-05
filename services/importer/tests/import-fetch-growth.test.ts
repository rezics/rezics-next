import { expect, test } from 'bun:test';
import { createImportFetch } from '../src/import-fetch.ts';

const origin = 'https://api.example.test';
const bulkUrl = origin + '/v1/subjects:batchWrite';
// One seed, fixed-width values and fixed command shape at all three scales.
const seed = (count: number) =>
  JSON.stringify({
    commands: Array.from({ length: count }, (_, index) => ({
      op: 'create',
      key: `command-${String(index).padStart(3, '0')}`,
      source: { source: 'bangumi', external_id: String(index).padStart(3, '0') },
    })),
  });
const post = (body = seed(1), headers: HeadersInit = {}) => new Request(bulkUrl, { method: 'POST', headers, body });

test('real adapter sends two attempts and linear supplied bytes at M = 1, 8, 64', async () => {
  const measurements: { commands: number; attempts: number; bytes: number; supplied: number }[] = [];
  for (const commands of [1, 8, 64]) {
    const body = seed(commands);
    let attempts = 0,
      bytes = 0;
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async () => {},
      fetch: (async (input, init) => {
        const req = new Request(input, init);
        attempts++;
        const serialized = await req.arrayBuffer();
        bytes += serialized.byteLength;
        expect(new TextDecoder().decode(serialized)).toBe(body);
        return attempts === 1 ? new Response(null, { status: 429 }) : new Response('ok');
      }) as typeof fetch,
    });
    expect((await client(post(body))).status).toBe(200);
    measurements.push({ commands, attempts, bytes, supplied: new TextEncoder().encode(body).byteLength });
  }
  for (const measurement of measurements) {
    expect(measurement.attempts).toBe(2);
    expect(measurement.bytes).toBe(2 * measurement.supplied);
  }
  const [small, medium, large] = measurements as [
    (typeof measurements)[number],
    (typeof measurements)[number],
    (typeof measurements)[number],
  ];
  expect((medium.bytes - small.bytes) / (medium.commands - small.commands)).toBe(
    (large.bytes - medium.bytes) / (large.commands - medium.commands),
  );
});

test('HTTP-date Retry-After uses the injected clock and never shortens advertised waits', async () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  for (const [header, minimum] of [
    ['Wed, 21 Oct 2015 07:28:09 GMT', 9000],
    ['3600', null],
  ] as const) {
    let calls = 0;
    const waits: number[] = [];
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ++calls === 1
          ? new Response(null, { status: 429, headers: { 'retry-after': header } })
          : new Response()) as typeof fetch,
    });
    const response = await client(post());
    if (minimum === null) {
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe(header);
      expect(await response.text()).toBe('');
      expect(waits).toEqual([]);
      expect(calls).toBe(1);
    } else {
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(minimum);
      expect(calls).toBe(2);
    }
  }
});

test('network uncertainty preserves exact bytes, URL, method and caller headers', async () => {
  const body = ' { "commands" : [{ "key": "x", "futureField": "雪" }] }\n';
  const seen: { url: string; method: string; bytes: number[]; headers: [string, string][] }[] = [];
  let tokenCalls = 0;
  const client = createImportFetch({
    origin,
    token: async () => {
      tokenCalls++;
      return 'actor';
    },
    sleep: async () => {},
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      seen.push({
        url: req.url,
        method: req.method,
        bytes: [...new Uint8Array(await req.arrayBuffer())],
        headers: [...req.headers],
      });
      if (seen.length === 1) throw new TypeError('lost response');
      return new Response();
    }) as typeof fetch,
  });
  await client(bulkUrl + '?mode=one', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'rezics-session-token': 'opaque', 'x-client': 'keep' },
  });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual(seen[1]);
  expect(seen[0]!.bytes).toEqual([...new TextEncoder().encode(body)]);
  expect(seen[0]!.url).toBe(bulkUrl + '?mode=one');
  expect(tokenCalls).toBe(1);
});

test('body cap counts UTF-8 bytes and stops streaming before reading the remainder', async () => {
  let sent = 0,
    tokens = 0,
    pulls = 0,
    cancelled = false;
  const client = createImportFetch({
    origin,
    maxBodyBytes: 8,
    token: async () => {
      tokens++;
      return 'actor';
    },
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      sent++;
      return new Response();
    }) as typeof fetch,
  });
  await expect(client(post('雪雪雪'))).rejects.toThrow();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(9));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(client(postStream(stream))).rejects.toThrow();
  expect(pulls).toBe(1);
  expect(cancelled).toBe(true);
  expect(sent).toBe(0);
  expect(tokens).toBe(0);
  expect((await client(post('12345678'))).status).toBe(200);
});

function postStream(body: ReadableStream<Uint8Array>, headers: HeadersInit = {}) {
  return new Request(bulkUrl, { method: 'POST', body, headers });
}

test('known excessive Content-Length is rejected before pulling and a false small length cannot bypass the cap', async () => {
  for (const length of ['100', '1']) {
    let pulls = 0,
      cancelled = false,
      sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(9));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const client = createImportFetch({
      origin,
      maxBodyBytes: 8,
      token: async () => 'actor',
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        sent++;
        return new Response();
      }) as typeof fetch,
    });
    await expect(client(postStream(stream, { 'content-length': length }))).rejects.toThrow();
    expect(pulls).toBe(length === '100' ? 0 : 1);
    expect(cancelled).toBe(true);
    expect(sent).toBe(0);
  }
});

test('redirects are returned untouched with manual redirect policy', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const response = new Response('redirect', { status, headers: { location: 'https://evil.example.test/v1/stolen' } });
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      fetch: (async (input, init) => {
        calls++;
        expect(new Request(input, init).redirect).toBe('manual');
        return response;
      }) as typeof fetch,
    });
    const result = await client(bulkUrl, { redirect: 'follow' });
    expect(result.status).toBe(response.status);
    expect(result.statusText).toBe(response.statusText);
    expect([...result.headers]).toEqual([...response.headers]);
    expect(await result.text()).toBe('redirect');
    expect(response.bodyUsed).toBe(true);
    expect(calls).toBe(1);
  }
});

test('abort prevents initial credentials, interrupts waiting, and stops before another attempt', async () => {
  const pre = new AbortController();
  const reason = new Error('cancel import');
  pre.abort(reason);
  let tokens = 0,
    calls = 0;
  const client = createImportFetch({
    origin,
    token: async () => {
      tokens++;
      return 'actor';
    },
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response(null, { status: 429 });
    }) as typeof fetch,
  });
  await expect(client(bulkUrl, { signal: pre.signal })).rejects.toBe(reason);
  expect(tokens).toBe(0);
  const controller = new AbortController();
  const waiting = createImportFetch({
    origin,
    token: async () => 'actor',
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response(null, { status: 429 });
    }) as typeof fetch,
    sleep: () => {
      controller.abort(reason);
      return new Promise(() => {});
    },
  });
  await expect(waiting(bulkUrl, { signal: controller.signal })).rejects.toBe(reason);
  expect(calls).toBe(1);
});

test('abort interrupts a pending request-body read and cancels its stream', async () => {
  const controller = new AbortController();
  const reason = new Error('body cancelled');
  let cancelled = false,
    calls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        controller.abort(reason);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const client = createImportFetch({
    origin,
    token: async () => 'actor',
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response();
    }) as typeof fetch,
  });
  await expect(client(postStream(stream), { signal: controller.signal })).rejects.toBe(reason);
  expect(cancelled).toBe(true);
  expect(calls).toBe(0);
});

test('repeated 429 is capped, cancels only retried bodies, and returns the actual final response', async () => {
  for (const attempts of [undefined, 1, 5]) {
    let calls = 0,
      cancelled = 0;
    const waits: number[] = [];
    const responses: Response[] = [];
    const client = createImportFetch({
      origin,
      ...(attempts === undefined ? {} : { maxAttempts: attempts }),
      token: async () => 'actor',
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        calls++;
        const response = new Response(
          new ReadableStream(
            {
              pull(controller) {
                controller.enqueue(new TextEncoder().encode('rate limited'));
                controller.close();
              },
              cancel() {
                cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 429, statusText: 'Too Many Requests', headers: { 'x-final': 'retained' } },
        );
        responses.push(response);
        return response;
      }) as typeof fetch,
    });
    const result = await client(post());
    expect(result.status).toBe(429);
    expect(result.statusText).toBe(responses.at(-1)!.statusText);
    expect([...result.headers]).toEqual([...responses.at(-1)!.headers]);
    expect(calls).toBe(attempts ?? 3);
    expect(waits).toHaveLength(calls - 1);
    expect(waits.every((ms) => Number.isFinite(ms) && ms >= 0 && ms <= 30000)).toBe(true);
    expect(cancelled).toBe(calls - 1);
    expect(result.bodyUsed).toBe(false);
    expect(await result.text()).toBe('rate limited');
    expect(responses.at(-1)!.bodyUsed).toBe(true);
  }
});

test('missing or malformed Retry-After uses finite bounded backoff', async () => {
  for (const header of [null, 'nonsense', '-1', 'Infinity', '1.5']) {
    let calls = 0;
    const waits: number[] = [];
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ++calls === 1
          ? new Response(null, { status: 429, headers: header === null ? {} : { 'retry-after': header } })
          : new Response()) as typeof fetch,
    });
    await client(bulkUrl);
    expect(waits).toHaveLength(1);
    expect(Number.isFinite(waits[0])).toBe(true);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(30000);
  }
});

test('GET and HEAD retry 5xx and transport failures, returning or throwing the actual final outcome', async () => {
  for (const method of ['GET', 'HEAD']) {
    const failure = new TypeError('last transport failure');
    let calls = 0;
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async () => {},
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        calls++;
        if (calls === 1) return new Response(null, { status: 503 });
        throw failure;
      }) as typeof fetch,
    });
    await expect(client(bulkUrl, { method })).rejects.toBe(failure);
    expect(calls).toBe(3);
    const response = new Response('server failure', { status: 500 });
    const http = createImportFetch({
      origin,
      token: async () => 'actor',
      maxAttempts: 2,
      sleep: async () => {},
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('temporary', { status: 502 })) as typeof fetch,
    });
    expect((await http(bulkUrl, { method })).status).toBe(502);
    const last = createImportFetch({
      origin,
      token: async () => 'actor',
      maxAttempts: 1,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => response) as typeof fetch,
    });
    const result = await last(bulkUrl, { method });
    expect(result.status).toBe(response.status);
    expect(result.statusText).toBe(response.statusText);
    expect([...result.headers]).toEqual([...response.headers]);
    expect(await result.text()).toBe('server failure');
    expect(response.bodyUsed).toBe(true);
  }
});

test('only POST with a valid caller Idempotency-Key retries arbitrary writes', async () => {
  for (const [method, key, expected] of [
    ['POST', '"stable-write"', 3],
    ['POST', '"escaped\\"key"', 3],
    ['POST', 'bare-key', 1],
    ['POST', '""', 1],
    ['POST', '"unfinished', 1],
    ['POST', `"${'a'.repeat(256)}"`, 1],
    ['PUT', '"stable-write"', 1],
    ['DELETE', '"stable-write"', 1],
  ] as const) {
    let calls = 0;
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async () => {},
      fetch: (async (input, init) => {
        expect(new Request(input, init).headers.get('idempotency-key')).toBe(key);
        calls++;
        return new Response(null, { status: 503 });
      }) as typeof fetch,
    });
    expect(
      (await client(origin + '/v1/subjects', { method, body: '{}', headers: { 'idempotency-key': key } })).status,
    ).toBe(503);
    expect(calls).toBe(expected);
  }
});

test('malformed, duplicate, empty or missing command keys never prove retry safety', async () => {
  for (const body of [
    '{}',
    '{',
    '{"commands":[]}',
    '{"commands":[null]}',
    '{"commands":[{"key":""}]}',
    '{"commands":[{"key":1}]}',
    '{"commands":[{"key":"one"},{}]}',
    '{"commands":[{"key":"same"},{"key":"same"}]}',
  ]) {
    let calls = 0;
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async () => {
        throw new Error('unsafe retry');
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        calls++;
        return new Response(null, { status: 429 });
      }) as typeof fetch,
    });
    expect((await client(post(body))).status).toBe(429);
    expect(calls).toBe(1);
  }
  for (const url of [origin + '/v1/media:importFromUrl', bulkUrl + '/extra']) {
    let calls = 0;
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async () => {},
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        calls++;
        return new Response(null, { status: 503 });
      }) as typeof fetch,
    });
    await client(url, { method: 'POST', body: seed(1) });
    expect(calls).toBe(1);
  }
});

test('unkeyed unsafe writes return their first HTTP failure without retrying', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const response = new Response('failure', { status });
    const client = createImportFetch({
      origin,
      token: async () => 'actor',
      sleep: async () => {
        throw new Error('unsafe retry');
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        calls++;
        return response;
      }) as typeof fetch,
    });
    const result = await client(origin + '/v1/media:importFromUrl', { method: 'POST', body: '{}' });
    expect(result.status).toBe(response.status);
    expect(result.statusText).toBe(response.statusText);
    expect([...result.headers]).toEqual([...response.headers]);
    expect(calls).toBe(1);
    expect(await result.text()).toBe('failure');
    expect(response.bodyUsed).toBe(true);
  }
});

test('origin and path guards run before obtaining credentials', async () => {
  let tokens = 0,
    calls = 0;
  const client = createImportFetch({
    origin,
    token: async () => {
      tokens++;
      return 'secret';
    },
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response();
    }) as typeof fetch,
  });
  for (const url of [
    'http://api.example.test/v1/x',
    'https://api.example.test:444/v1/x',
    'https://api.example.test.evil.test/v1/x',
    origin + '/v10/x',
    origin + '/v1',
    origin + '/v1/../outside',
    'https://user:password@api.example.test/v1/x',
  ]) {
    await expect(client(url)).rejects.toThrow();
  }
  expect(tokens).toBe(0);
  expect(calls).toBe(0);
});

test('invalid bounds fail at construction and token failures never hit upstream', async () => {
  for (const maxAttempts of [0, 6, 1.5, NaN, Infinity]) {
    expect(() => createImportFetch({ origin, token: async () => 'actor', maxAttempts })).toThrow();
  }
  for (const maxBodyBytes of [-1, 1.5, NaN, Infinity]) {
    expect(() => createImportFetch({ origin, token: async () => 'actor', maxBodyBytes })).toThrow();
  }
  const failure = new Error('token unavailable');
  let calls = 0;
  const client = createImportFetch({
    origin,
    token: async () => {
      throw failure;
    },
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return new Response();
    }) as typeof fetch,
  });
  await expect(client(post())).rejects.toBe(failure);
  expect(calls).toBe(0);
});

test('keyed VNDB statistic PUT keeps existing physical attempt, wait and supplied-byte ceilings', async () => {
  const body = '{ "sourceRecordId": "v123", "mean": 8.1, "count": 20 }';
  const waits: number[] = [];
  let attempts = 0,
    bytes = 0,
    tokens = 0;
  const client = createImportFetch({
    origin,
    now: () => 0,
    token: async () => {
      tokens++;
      return 'actor';
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: (async (input, init): Promise<Response> => {
      const request = new Request(input, init);
      attempts++;
      const supplied = await request.arrayBuffer();
      bytes += supplied.byteLength;
      expect(new TextDecoder().decode(supplied)).toBe(body);
      expect(request.headers.get('idempotency-key')).toBe('"statistic-stable"');
      throw new TypeError('Acknowledgement unavailable');
    }) as typeof fetch,
  });
  await expect(
    client(origin + '/v1/subjects/00000000-0000-4000-8000-000000000101/source-statistics/vndb', {
      method: 'PUT',
      headers: { 'idempotency-key': '"statistic-stable"' },
      body,
    }),
  ).rejects.toThrow('Acknowledgement unavailable');
  expect(attempts).toBe(3);
  expect(waits).toEqual([1000, 2000]);
  expect(bytes).toBe(3 * new TextEncoder().encode(body).byteLength);
  expect(tokens).toBe(1);
});
