import { expect, spyOn, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { checkBatchWrite, checkBatchWriteResult, type BatchWriteRequest } from '@rezics/definitions/bulk';
import { loadHttpBoundsDriver, type HttpBoundsDriver, type ImportHttpOptions } from './imports-http-bounds-driver';

const ORIGIN = 'https://api.example.test';
const MIB = 1024 * 1024;
const SECRET = 'credential-sentinel';
const SOURCE = 'source-body-sentinel';
const NOW = Date.UTC(2026, 0, 1);
const jsonBytes = (size: number) => new TextEncoder().encode(`{}${' '.repeat(size - 2)}`);
const flush = async () => {
  for (let i = 0; i < 64; i++) await Promise.resolve();
};
function clock() {
  let time = NOW;
  const timers = new Map<() => void, number>();
  return {
    now: () => time,
    schedule(callback: () => void, ms: number) {
      timers.set(callback, time + ms);
      return () => {
        timers.delete(callback);
      };
    },
    advance(ms: number) {
      time += ms;
      for (const [callback, due] of timers)
        if (due <= time) {
          timers.delete(callback);
          callback();
        }
    },
    timers,
  };
}
function streamed(total: number, chunkSize = 4096, headers?: HeadersInit, status = 200) {
  let consumed = 0;
  let cancelled = 0;
  let closed = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (consumed === total) {
          closed = true;
          controller.close();
          return;
        }
        const length = Math.min(chunkSize, total - consumed);
        const chunk = new Uint8Array(length).fill(32);
        if (consumed === 0) {
          chunk[0] = 123;
          chunk[1] = 125;
        }
        consumed += length;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { status, ...(headers === undefined ? {} : { headers }) }),
    stats: () => ({ consumed, cancelled, closed }),
  };
}
function harness(
  driver: HttpBoundsDriver,
  replies: (index: number, request: Request) => Response | Promise<Response>,
  limits: Partial<ImportHttpOptions> = {},
) {
  const time = clock();
  const requests: { url: string; method: string; headers: [string, string][]; body: string }[] = [];
  const signals: AbortSignal[] = [];
  const waits: number[] = [];
  let calls = 0;
  const options: ImportHttpOptions = {
    origin: ORIGIN,
    token: async () => SECRET,
    now: time.now,
    schedule: time.schedule,
    sleep: async (ms) => {
      waits.push(ms);
      time.advance(ms);
    },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      signals.push(request.signal);
      requests.push({
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body: await request.text(),
      });
      return replies(calls++, request);
    }) as typeof fetch,
    ...limits,
  };
  const transport = driver.product.createImportFetch(options);
  return { transport, options, requests, signals, waits, time, calls: () => calls };
}
const get = (transport: typeof fetch, signal?: AbortSignal) =>
  transport(`${ORIGIN}/v1/subjects?limit=1`, signal === undefined ? {} : { signal });
async function rejected(operation: () => Promise<unknown>) {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(SECRET);
  expect(String(failure)).not.toContain(SOURCE);
}
function pendingResult(operation: Promise<unknown>) {
  const state = { settled: false, rejected: false };
  void operation.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
      state.rejected = true;
    },
  );
  return state;
}

test('exports immutable service ceilings and rejects every invalid or raised setting before IO', async () => {
  const driver = await loadHttpBoundsDriver();
  const p = driver.product;
  expect<number[]>([
    p.MAX_IMPORT_BODY_BYTES,
    p.MAX_IMPORT_RESPONSE_BYTES,
    p.MAX_IMPORT_WAIT_MS,
    p.MAX_IMPORT_TOTAL_WAIT_MS,
    p.MAX_IMPORT_DEADLINE_MS,
    p.MAX_IMPORT_ATTEMPTS,
  ]).toEqual([2 * MIB, MIB, 30000, 60000, 120000, 5]);
  const limits = {
    maxBodyBytes: 2 * MIB,
    maxResponseBytes: MIB,
    maxWaitMs: 30000,
    maxTotalWaitMs: 60000,
    deadlineMs: 120000,
    maxAttempts: 5,
  };
  for (const [name, hard] of Object.entries(limits)) {
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      hard + 1,
      '1',
      null,
      true,
      {},
      1n,
      ...(name === 'deadlineMs' || name === 'maxAttempts' ? [0] : []),
    ]) {
      let calls = 0;
      expect(() =>
        p.createImportFetch({
          origin: ORIGIN,
          token: async () => {
            calls++;
            return SECRET;
          },
          fetch: (() => {
            calls++;
            throw new Error('unexpected network');
          }) as unknown as typeof fetch,
          [name]: value,
        }),
      ).toThrow(RangeError);
      expect(calls).toBe(0);
    }
  }
});

test('request default hard cap stops streamed bytes and cannot be raised by configuration', async () => {
  const driver = await loadHttpBoundsDriver();
  const h = harness(driver, () => Response.json({}));
  const source = streamed(16 * MIB);
  await rejected(() => h.transport(`${ORIGIN}/v1/import`, { method: 'POST', body: source.response.body }));
  expect(source.stats().consumed).toBeLessThanOrEqual(2 * MIB + 4096);
  expect(source.stats().cancelled).toBe(1);
  expect(h.calls()).toBe(0);
  expect(() => driver.product.createImportFetch({ ...h.options, maxBodyBytes: 2 * MIB + 1 })).toThrow(RangeError);
  const exact = new TextEncoder().encode(SOURCE.padEnd(2 * MIB, ' '));
  expect((await h.transport(`${ORIGIN}/v1/import`, { method: 'POST', body: exact })).status).toBe(200);
  expect(h.requests[0]!.body.length).toBe(2 * MIB);
  const lowered = harness(driver, () => Response.json({}), { maxBodyBytes: SOURCE.length - 1 });
  await rejected(() => lowered.transport(`${ORIGIN}/v1/import`, { method: 'POST', body: SOURCE }));
  expect(lowered.calls()).toBe(0);
});

test('decoded streaming bytes enforce default and lowered caps despite absent or lying content length', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const headers of [
    undefined,
    { 'content-length': '2' },
    { 'content-encoding': 'gzip', 'content-length': '19' },
  ]) {
    for (const cap of [MIB, 8192]) {
      const source = streamed(8 * MIB, 4096, headers);
      const h = harness(driver, () => source.response, cap === MIB ? {} : { maxResponseBytes: cap });
      await rejected(async () => (await get(h.transport)).json());
      expect(source.stats().consumed).toBeLessThanOrEqual(cap + 4096);
      expect(source.stats().cancelled).toBe(1);
      expect(h.calls()).toBe(1);
    }
  }
});

test('exact cap remains complete JSON and advisory oversized content length does not reject actual bounded bytes', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const cap of [0, 2, MIB]) {
    const source = streamed(cap, 4096, { 'content-length': String(9 * MIB), [SESSION_HEADER]: 'session-next' }, 201);
    const h = harness(driver, () => source.response, { maxResponseBytes: cap });
    const response = await get(h.transport);
    expect(response.status).toBe(201);
    expect(response.headers.get(SESSION_HEADER)).toBe('session-next');
    expect(response.headers.get('content-length')).toBe(String(9 * MIB));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(cap === 0 ? new Uint8Array() : jsonBytes(cap));
    expect(source.stats().closed).toBe(true);
  }
});

test('valid JSON prefix never turns an oversized or malformed response into success', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const bytes of [
    new TextEncoder().encode('{} trailing-invalid'),
    jsonBytes(MIB + 1),
    new TextEncoder().encode('{"results":['),
  ]) {
    const h = harness(driver, () => new Response(bytes));
    await rejected(async () => (await get(h.transport)).json());
    expect(h.calls()).toBe(1);
  }
});

test('rejects abusive chunk backing before copying and rejects opaque non-byte chunks safely', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const value of [
    new Uint8Array(new ArrayBuffer(MIB + 1), 0, 2),
    { secret: SOURCE },
    new DataView(new ArrayBuffer(2)),
    'opaque',
    null,
  ]) {
    if (value instanceof Uint8Array) value.set([123, 125]);
    let cancelled = 0;
    let delivered = false;
    const response = new Response(
      new ReadableStream<unknown>(
        {
          pull(controller) {
            if (delivered) {
              controller.close();
              return;
            }
            delivered = true;
            controller.enqueue(value);
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ) as ReadableStream<Uint8Array>,
    );
    const h = harness(driver, () => response);
    const { observation } = await driver.observe(() => rejected(async () => (await get(h.transport)).json()));
    expect(cancelled).toBe(1);
    expect(observation.responseByteVisits).toBe(0);
    expect(observation.databaseCalls).toBe(0);
  }
});

test('three input scales consume linear bytes below cap then constant bytes and bounded backing above cap without clone or tee', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const base of [4096, MIB + 4096])
    for (const scale of [1, 8, 64]) {
      const size = base * scale;
      const source = streamed(size);
      const h = harness(driver, () => source.response);
      const clone = spyOn(source.response, 'clone');
      const tee = spyOn(source.response.body!, 'tee');
      try {
        const { observation } = await driver.observe(async () => {
          if (size > MIB) await rejected(async () => (await get(h.transport)).json());
          else expect(await (await get(h.transport)).json()).toEqual({});
        });
        expect(source.stats().consumed).toBe(size <= MIB ? size : MIB + 4096);
        expect(source.stats().cancelled).toBe(size <= MIB ? 0 : 1);
        expect(observation.responseByteVisits).toBeGreaterThanOrEqual(Math.min(size, MIB));
        expect(observation.responseByteVisits).toBeLessThanOrEqual(8 * Math.min(size, MIB) + 4096);
        expect(observation.peakResponseBackingBytes).toBeGreaterThanOrEqual(Math.min(size, 4096));
        expect(observation.peakResponseBackingBytes).toBeLessThanOrEqual(4 * MIB + 4096);
        expect(observation.databaseCalls).toBe(0);
        expect(clone).not.toHaveBeenCalled();
        expect(tee).not.toHaveBeenCalled();
      } finally {
        clone.mockRestore();
        tee.mockRestore();
      }
    }
});

test('real downstream client consumes all 100 portable receipts with preserved status headers and session', async () => {
  const driver = await loadHttpBoundsDriver();
  const results = Array.from({ length: 100 }, (_, i) => ({
    key: `key-${i}`,
    status: 201,
    value: { id: '11111111-1111-4111-8111-111111111111', revision: 1 },
  }));
  const sessions: string[] = [];
  const h = harness(driver, () => Response.json({ results }, { headers: { [SESSION_HEADER]: 'session-next' } }));
  const client = createKernelClient(ORIGIN, {
    fetch: h.transport,
    session: 'session-old',
    onSession: (token) => sessions.push(token),
  });
  // Eden's real proxy accepts the portable route before generated bulk types land.
  const bulk = client as unknown as {
    'subjects:batchWrite': {
      post(body: BatchWriteRequest): Promise<{ status: number; data: unknown }>;
    };
  };
  const body: BatchWriteRequest = {
    commands: results.map((r) => ({
      op: 'create',
      key: r.key,
      subject: { type: 'schema:Book', labels: { en: 'Book' } },
      source: {
        source: 'bangumi',
        external_id: r.key,
        record_revision: 'unversioned',
        digest: 'a'.repeat(64),
        converter_revision: 'v1',
        field_group: 'facts',
      },
    })),
  };
  expect(checkBatchWrite(body)).toEqual([]);
  expect(checkBatchWriteResult({ results })).toEqual([]);
  const { value, observation } = await driver.observe(() => bulk['subjects:batchWrite'].post(body));
  expect(value.status).toBe(200);
  expect(value.data).toEqual({ results });
  expect(sessions).toEqual(['session-next']);
  expect(h.requests[0]!.headers).toContainEqual([SESSION_HEADER, 'session-old']);
  expect(h.requests[0]!.url).toBe(`${ORIGIN}/v1/subjects:batchWrite`);
  expect(observation.databaseCalls).toBe(0);
  // The same real client must not acknowledge even valid results followed by
  // an oversized whitespace suffix. Eden may throw or return an error result.
  const oversized = harness(driver, () => new Response(JSON.stringify({ results }) + ' '.repeat(MIB)));
  const boundedClient = createKernelClient(ORIGIN, { fetch: oversized.transport }) as unknown as typeof bulk;
  let acknowledged = false;
  try {
    acknowledged = (await boundedClient['subjects:batchWrite'].post(body)).data != null;
  } catch {
    /* transport rejection */
  }
  expect(acknowledged).toBe(false);
});

test('advertised delays above single or remaining budget return terminal 429 intact without early sleep', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const retryAfter of ['31', '999999999999999999999999', new Date(NOW + 31000).toUTCString()]) {
    const h = harness(driver, () =>
      Response.json(
        { retry: 'later' },
        { status: 429, headers: { 'retry-after': retryAfter, [SESSION_HEADER]: 'limited-session' } },
      ),
    );
    const response = await get(h.transport);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(retryAfter);
    expect(response.headers.get(SESSION_HEADER)).toBe('limited-session');
    expect(await response.json()).toEqual({ retry: 'later' });
    expect(h.waits).toEqual([]);
    expect(h.calls()).toBe(1);
  }
  const h = harness(driver, () => Response.json({}, { status: 429, headers: { 'retry-after': '7' } }), {
    maxWaitMs: 8000,
    maxTotalWaitMs: 10000,
  });
  expect((await get(h.transport)).status).toBe(429);
  expect(h.waits).toEqual([7000]);
  expect(h.calls()).toBe(2);
});

test('exact single and cumulative budgets are inclusive and common to the entire logical request', async () => {
  const driver = await loadHttpBoundsDriver();
  const h = harness(driver, () => Response.json({}, { status: 429, headers: { 'retry-after': '30' } }), {
    maxAttempts: 5,
  });
  expect((await get(h.transport)).status).toBe(429);
  expect(h.waits).toEqual([30000, 30000]);
  expect(h.calls()).toBe(3);
  const zero = harness(driver, () => Response.json({}, { status: 429, headers: { 'retry-after': '1' } }), {
    maxWaitMs: 0,
    maxTotalWaitMs: 0,
  });
  expect((await get(zero.transport)).status).toBe(429);
  expect(zero.waits).toEqual([]);
  const immediate = harness(
    driver,
    (index) =>
      index === 0 ? Response.json({}, { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ ok: true }),
    { maxWaitMs: 0, maxTotalWaitMs: 0 },
  );
  expect((await get(immediate.transport)).status).toBe(200);
  expect(immediate.waits.every((ms) => ms === 0)).toBe(true);
  expect(immediate.calls()).toBe(2);
});

test('valid seven second HTTP date and fallback waits preserve retry identity and close discarded bodies', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const header of ['7', new Date(NOW + 7000).toUTCString(), 'malformed']) {
    const discarded = [streamed(64, 64, { 'retry-after': header }, 429), streamed(64, 64, undefined, 503)];
    const h = harness(driver, (index) => discarded[index]?.response ?? Response.json({ ok: true }), { maxAttempts: 5 });
    const response = await h.transport(`${ORIGIN}/v1/media:import?exact=a%2Fb`, {
      method: 'POST',
      headers: {
        'idempotency-key': '"stable-key"',
        'content-type': 'application/json',
        [SESSION_HEADER]: 'same-session',
      },
      body: JSON.stringify({ source: SOURCE }),
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(h.waits).toEqual([header === 'malformed' ? 1000 : 7000, 2000]);
    expect(h.requests).toHaveLength(3);
    for (const request of h.requests) expect(request).toEqual(h.requests[0]!);
    expect(h.requests[0]!.url).toBe(`${ORIGIN}/v1/media:import?exact=a%2Fb`);
    expect(h.requests[0]!.method).toBe('POST');
    expect(h.requests[0]!.body).toBe(JSON.stringify({ source: SOURCE }));
    expect(h.requests[0]!.headers).toContainEqual(['authorization', `Bearer ${SECRET}`]);
    expect(h.requests[0]!.headers).toContainEqual(['idempotency-key', '"stable-key"']);
    for (const source of discarded) expect(source.stats().cancelled + Number(source.stats().closed)).toBe(1);
  }
});

test('network errors and HTTP retries share lowered wait budget and never exceed five attempts', async () => {
  const driver = await loadHttpBoundsDriver();
  const h = harness(
    driver,
    (index) => {
      if (index === 0) throw new TypeError('offline');
      return Response.json({}, { status: 429, headers: { 'retry-after': '2' } });
    },
    { maxAttempts: 5, maxTotalWaitMs: 3000 },
  );
  expect((await get(h.transport)).status).toBe(429);
  expect(h.waits).toEqual([1000, 2000]);
  expect(h.calls()).toBe(3);
  const attempts = harness(driver, () => Response.json({}, { status: 503 }), { maxAttempts: 5 });
  expect((await get(attempts.transport)).status).toBe(503);
  expect(attempts.waits).toEqual([1000, 2000, 4000, 8000]);
  expect(attempts.calls()).toBe(5);
  for (const [limits, expected] of [
    [{ maxWaitMs: 999 }, []],
    [{ maxTotalWaitMs: 3000 }, [1000, 2000]],
  ] as const) {
    const offline = harness(
      driver,
      () => {
        throw new TypeError('offline');
      },
      { maxAttempts: 5, ...limits },
    );
    await rejected(() => get(offline.transport));
    expect(offline.waits).toEqual([...expected]);
    expect(offline.calls()).toBe(expected.length + 1);
  }
  const once = harness(driver, () => Response.json({}, { status: 503 }), { maxAttempts: 1 });
  expect((await get(once.transport)).status).toBe(503);
  expect(once.waits).toEqual([]);
  expect(once.calls()).toBe(1);
});

test('terminal 401 and 403 retain status headers and bounded body without retry', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const status of [401, 403]) {
    const h = harness(driver, () =>
      Response.json({ denied: true }, { status, headers: { [SESSION_HEADER]: 'denied-session' } }),
    );
    const response = await get(h.transport);
    expect(response.status).toBe(status);
    expect(response.headers.get(SESSION_HEADER)).toBe('denied-session');
    expect(await response.json()).toEqual({ denied: true });
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
    const oversized = streamed(MIB + 4096, 4096, undefined, status);
    const bounded = harness(driver, () => oversized.response);
    await rejected(async () => (await get(bounded.transport)).json());
    expect(oversized.stats().cancelled).toBe(1);
  }
});

// Fixed microtask drains observe settlement; no elapsed-time threshold or hanging
// await on defective production. The test's caller abort always cleans up.
async function interrupt(
  driver: HttpBoundsDriver,
  stage: 'request' | 'token' | 'network' | 'response' | 'injected' | 'native',
  deadline: boolean,
  deadlineMs?: number,
) {
  const caller = new AbortController();
  let cancelled = 0;
  let entered = false;
  const never = () => new Promise<never>(() => {});
  const h = harness(
    driver,
    () => {
      entered = true;
      if (stage === 'network') return never();
      if (stage === 'response')
        return new Response(
          new ReadableStream(
            {
              pull() {
                entered = true;
                return never();
              },
              cancel() {
                cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
        );
      return Response.json({}, { status: 503 });
    },
    deadlineMs === undefined ? {} : { deadlineMs },
  );
  if (stage === 'token')
    h.options.token = () => {
      entered = true;
      return never();
    };
  if (stage === 'injected')
    h.options.sleep = () => {
      entered = true;
      return never();
    };
  if (stage === 'native') delete h.options.sleep;
  const transport = driver.product.createImportFetch(h.options);
  const body =
    stage === 'request'
      ? new ReadableStream<Uint8Array>(
          {
            pull() {
              entered = true;
              return never();
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        )
      : undefined;
  const state = pendingResult(
    (async () => {
      const response = body
        ? await transport(`${ORIGIN}/v1/import`, { method: 'POST', body, signal: caller.signal })
        : await get(transport, caller.signal);
      await response.arrayBuffer();
    })(),
  );
  try {
    await flush();
    expect(entered).toBe(true);
    expect(state.settled).toBe(false);
    if (deadline) {
      expect([...h.time.timers.values()]).toContain(NOW + (deadlineMs ?? 120000));
      h.time.advance(deadlineMs ?? 120000);
    } else caller.abort(new Error('caller cancelled'));
    await flush();
    expect(state).toEqual({ settled: true, rejected: true });
    for (const signal of h.signals) expect(signal.aborted).toBe(true);
    if (stage === 'request' || stage === 'response') expect(cancelled).toBe(1);
    expect(h.time.timers.size).toBe(0);
    expect(h.calls()).toBeLessThanOrEqual(1);
  } finally {
    caller.abort();
    await flush();
  }
}

test('caller cancellation interrupts pending request token network response and both sleep paths', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const stage of ['request', 'token', 'network', 'response', 'injected', 'native'] as const)
    await interrupt(driver, stage, false);
});

test('default and lowered service deadline terminate all pending IO including hooks without wall time', async () => {
  const driver = await loadHttpBoundsDriver();
  for (const deadline of [undefined, 17])
    for (const stage of ['request', 'token', 'network', 'response', 'injected', 'native'] as const)
      await interrupt(driver, stage, true, deadline);
});

test('default native deadline and retry timers are scheduled at bounded delays and cleared on abort', async () => {
  const driver = await loadHttpBoundsDriver();
  const h = harness(driver, () => Response.json({}, { status: 503 }));
  delete h.options.schedule;
  delete h.options.sleep;
  const abort = new AbortController();
  const timers = spyOn(globalThis, 'setTimeout');
  const clear = spyOn(globalThis, 'clearTimeout');
  try {
    const transport = driver.product.createImportFetch(h.options);
    const state = pendingResult(get(transport, abort.signal));
    await flush();
    expect(timers.mock.calls.map((call) => call[1])).toEqual([120000, 1000]);
    abort.abort();
    await flush();
    expect(state).toEqual({ settled: true, rejected: true });
    for (const result of timers.mock.results)
      expect(clear.mock.calls.some((call) => call[0] === result.value)).toBe(true);
    expect(h.calls()).toBe(1);
  } finally {
    abort.abort();
    await flush();
    timers.mockRestore();
    clear.mockRestore();
  }
});

test('one deadline spans scheduled waits and later attempts rather than restarting for each stage', async () => {
  const driver = await loadHttpBoundsDriver();
  const abort = new AbortController();
  const h = harness(driver, (index) =>
    index === 0 ? Response.json({}, { status: 503 }) : new Promise<Response>(() => {}),
  );
  const state = pendingResult(get(h.transport, abort.signal));
  try {
    await flush();
    expect(h.waits).toEqual([1000]);
    expect(h.calls()).toBe(2);
    expect([...h.time.timers.values()]).toEqual([NOW + 120000]);
    h.time.advance(118999);
    await flush();
    expect(state.settled).toBe(false);
    h.time.advance(1);
    await flush();
    expect(state).toEqual({ settled: true, rejected: true });
    expect(h.signals[1]!.aborted).toBe(true);
    expect(h.time.timers.size).toBe(0);
  } finally {
    abort.abort();
    await flush();
  }
});

test('response read failure and late network completion close upstream without leaking sensitive data', async () => {
  const driver = await loadHttpBoundsDriver();
  let cancelled = 0;
  const h = harness(
    driver,
    () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              throw new TypeError('broken response');
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  await rejected(async () => (await get(h.transport)).json());
  expect(h.calls()).toBe(1);
  let finish!: (response: Response) => void;
  const late = harness(
    driver,
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const state = pendingResult(get(late.transport, abort.signal));
  await flush();
  abort.abort();
  await flush();
  expect(state.rejected).toBe(true);
  finish(
    new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  await flush();
  expect(cancelled).toBe(1);
});
