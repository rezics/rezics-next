import { expect, test } from 'bun:test';
import { setupRequest } from './support/setup-retry.ts';

const overloaded = { code: 'overloaded', retryable: true, effect_status: 'not_applied' };
const request = () =>
  new Request('https://kernel.test/v1/grants', {
    method: 'POST',
    headers: { 'Idempotency-Key': '"fixed-key"' },
    body: '{"grant":"unchanged"}',
  });
function clock(budget = 10_000) {
  let time = Date.parse('2026-10-27T00:00:00Z');
  const waits: number[] = [];
  return {
    deadline: time + budget,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
}

test('setup retries preserve the key and consumed request body and honour Retry-After', async () => {
  const timing = clock();
  const seen: { key: string | null; body: string; at: number }[] = [];
  const result = await setupRequest(
    async (input) => {
      seen.push({ key: input.headers.get('Idempotency-Key'), body: await input.text(), at: timing.now() });
      return seen.length === 1
        ? Response.json(overloaded, { status: 503, headers: { 'Retry-After': '2' } })
        : Response.json({ created: true }, { status: 201 });
    },
    request(),
    timing,
  );
  expect(seen).toHaveLength(2);
  expect(seen.map(({ key, body }) => ({ key, body }))).toEqual([
    { key: '"fixed-key"', body: '{"grant":"unchanged"}' },
    { key: '"fixed-key"', body: '{"grant":"unchanged"}' },
  ]);
  expect(seen[1]!.at - seen[0]!.at).toBe(2000);
  expect(timing.waits).toEqual([2000]);
  expect(result.status).toBe(201);
  expect(await result.json()).toEqual({ created: true });
});

test('setup falls back to doubling 50 ms waits and fails with the sixth answer body', async () => {
  const timing = clock();
  let attempts = 0;
  await expect(
    setupRequest(async () => Response.json({ ...overloaded, attempt: ++attempts }, { status: 503 }), request(), timing),
  ).rejects.toThrow(JSON.stringify({ ...overloaded, attempt: 6 }));
  expect(attempts).toBe(6);
  expect(timing.waits).toEqual([50, 100, 200, 400, 800]);
});

test('Retry-After supports HTTP dates and invalid values use the fallback', async () => {
  for (const retryAfter of ['Tue, 27 Oct 2026 00:00:03 GMT', 'invalid', '-1', '1.5']) {
    const timing = clock();
    let attempts = 0;
    await setupRequest(
      async () =>
        ++attempts === 1
          ? Response.json(overloaded, { status: 503, headers: { 'Retry-After': retryAfter } })
          : new Response(null, { status: 204 }),
      request(),
      timing,
    );
    expect(timing.waits).toEqual([retryAfter.startsWith('Tue') ? 3000 : 50]);
  }
});

test('setup failures without the complete retry contract fail immediately with their body', async () => {
  for (const [status, body] of [
    [503, { ...overloaded, retryable: false }],
    [503, { ...overloaded, retryable: 'true' }],
    [503, { retryable: true }],
    [503, { ...overloaded, effect_status: 'unknown' }],
    [503, { ...overloaded, effect_status: 'applied' }],
    [503, null],
    [429, overloaded],
    [500, overloaded],
    [403, { code: 'forbidden' }],
  ] as const) {
    const timing = clock();
    let attempts = 0;
    await expect(
      setupRequest(
        async () => {
          attempts++;
          return Response.json(body, { status });
        },
        request(),
        timing,
      ),
    ).rejects.toThrow(`(${status}): ${JSON.stringify(body)}`);
    expect(attempts).toBe(1);
    expect(timing.waits).toEqual([]);
  }
});

test('a non-JSON setup failure reports the original body without retrying', async () => {
  const timing = clock();
  await expect(
    setupRequest(async () => new Response('unavailable upstream', { status: 503 }), request(), timing),
  ).rejects.toThrow('(503): unavailable upstream');
  expect(timing.waits).toEqual([]);
});

test('setup stops before a wait would reach the deadline and reports the last answer', async () => {
  const timing = clock(125);
  let attempts = 0;
  await expect(
    setupRequest(async () => Response.json({ ...overloaded, attempt: ++attempts }, { status: 503 }), request(), timing),
  ).rejects.toThrow(JSON.stringify({ ...overloaded, attempt: 2 }));
  expect(attempts).toBe(2);
  expect(timing.waits).toEqual([50]);
  expect(timing.now()).toBeLessThan(timing.deadline);
});

test('setup never shortens Retry-After to fit the deadline or retries after an overslept wait', async () => {
  for (const oversleep of [false, true]) {
    const timing = clock(100);
    let attempts = 0;
    await expect(
      setupRequest(
        async () => {
          attempts++;
          return Response.json(overloaded, {
            status: 503,
            ...(oversleep ? {} : { headers: { 'Retry-After': '1' } }),
          });
        },
        request(),
        { ...timing, sleep: async () => timing.sleep(200) },
      ),
    ).rejects.toThrow(JSON.stringify(overloaded));
    expect(attempts).toBe(1);
    expect(timing.waits).toEqual(oversleep ? [200] : []);
  }
});

test('setup reads retry overload safely and unexpected successful statuses fail with their body', async () => {
  const timing = clock();
  let attempts = 0;
  const result = await setupRequest(
    async () => (++attempts === 1 ? Response.json(overloaded, { status: 503 }) : Response.json({ posts: [] })),
    new Request('https://kernel.test/v1/threads/example/posts'),
    timing,
  );
  expect(await result.json()).toEqual({ posts: [] });
  await expect(
    setupRequest(async () => Response.json({ unexpected: true }), request(), { ...timing, status: 201 }),
  ).rejects.toThrow('(200): {"unexpected":true}');
});

test('setup reads retry not_applicable overloads with Retry-After and leave successful bodies readable', async () => {
  const timing = clock();
  const seen: (string | null)[] = [];
  const result = await setupRequest(
    async (input) => {
      seen.push(input.headers.get('Idempotency-Key'));
      return seen.length === 1
        ? Response.json(
            { ...overloaded, effect_status: 'not_applicable' },
            { status: 503, headers: { 'Retry-After': '1' } },
          )
        : Response.json({ posts: [{ id: 'before-delete' }] });
    },
    new Request('https://kernel.test/v1/threads/example/posts'),
    { ...timing, status: 200 },
  );
  expect(seen).toEqual([null, null]);
  expect(timing.waits).toEqual([1000]);
  expect(await result.json()).toEqual({ posts: [{ id: 'before-delete' }] });
});

test('not_applicable setup overloads also stop at six attempts with the last body', async () => {
  const timing = clock();
  let attempts = 0;
  const problem = { ...overloaded, effect_status: 'not_applicable' };
  await expect(
    setupRequest(
      async () => Response.json({ ...problem, attempt: ++attempts }, { status: 503 }),
      new Request('https://kernel.test/v1/threads/example/posts'),
      timing,
    ),
  ).rejects.toThrow(JSON.stringify({ ...problem, attempt: 6 }));
  expect(attempts).toBe(6);
  expect(timing.waits).toEqual([50, 100, 200, 400, 800]);
});

test('setup generates one key for an unkeyed write and reuses it across retries', async () => {
  const keys: (string | null)[] = [];
  await setupRequest(
    async (input) => {
      keys.push(input.headers.get('Idempotency-Key'));
      return keys.length === 1 ? Response.json(overloaded, { status: 503 }) : new Response(null, { status: 204 });
    },
    new Request('https://auth.test/token', { method: 'POST', body: '{}' }),
    clock(),
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBeNull();
  expect(keys[1]).toBe(keys[0]);
});

test('expired setup does not send a request and transport failures are not retried', async () => {
  let attempts = 0;
  const failure = new Error('transport failed');
  const handle = async () => {
    attempts++;
    throw failure;
  };
  await expect(setupRequest(handle, request(), clock(0))).rejects.toThrow('before the first attempt');
  expect(attempts).toBe(0);
  const timing = clock();
  await expect(setupRequest(handle, request(), timing)).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(timing.waits).toEqual([]);
});
