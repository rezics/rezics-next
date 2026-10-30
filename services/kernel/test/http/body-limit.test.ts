import { afterAll, expect, spyOn, test } from 'bun:test';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import {
  bodyBytes,
  bodyWireBytes,
  DEFAULT_BODY_LIMIT,
  IngressBodyBudget,
  MAX_BODY_LIMIT,
  parseBoundedBody,
  readBoundedBody,
} from '../../src/http/body.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { createPool } from '../../src/database/pool.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { ADMISSION_LIMITS } from '../../src/http/admission.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';

function streamed(chunks: Uint8Array[], extraHeaders: Record<string, string> = {}) {
  let reads = 0;
  let cancelled = false;
  const request = new Request('http://localhost/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    // Bun's Request requires duplex for streamed bodies; its type omits the extension.
    duplex: 'half',
  } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}

test('a JSON body over the default wire limit is refused before parsing and reading stops at the limit', async () => {
  const source = streamed([new Uint8Array(DEFAULT_BODY_LIMIT), new Uint8Array([0])]);
  await expect(parseBoundedBody(source.request, DEFAULT_BODY_LIMIT, 'json')).rejects.toMatchObject({
    code: 'content_too_large',
  });
  expect(source.cancelled()).toBe(true);
  expect(source.reads()).toBeLessThanOrEqual(3);
});

test('a default-limit request fails before schema validation, authorization, or effects', async () => {
  let handlerRuns = 0;
  let accessRuns = 0;
  const app = createApp({
    pool: {} as Pool,
    access: (() => {
      accessRuns++;
      throw new Error('authorization must not run');
    }) as never,
  }).post(
    '/body-limit-probe',
    {
      body: t.Object({ valid: t.Boolean() }),
      detail: {
        operationId: 'probe.body_limit',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    () => {
      handlerRuns++;
      return { ok: true };
    },
  );
  const response = await app.handle(
    new Request('http://localhost/body-limit-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valid: true, padding: 'x'.repeat(DEFAULT_BODY_LIMIT) }),
    }),
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'content_too_large' });
  expect(handlerRuns).toBe(0);
  expect(accessRuns).toBe(0);
});

test('a declared Content-Length over the route limit is refused before any body byte is read', async () => {
  const source = streamed([new Uint8Array([123])], { 'content-length': '2' });
  await expect(readBoundedBody(source.request, 1)).rejects.toMatchObject({ code: 'content_too_large' });
  expect(source.reads()).toBe(0);
});

test('a bodyless request does not require a JSON content type', async () => {
  const request = new Request('http://localhost/probe', { method: 'POST' });
  expect(await parseBoundedBody(request, DEFAULT_BODY_LIMIT, 'json')).toBeUndefined();
  expect(bodyWireBytes(request)).toBe(0);
});

test('a route reads its owned bytes and wire count, and the captured bytes remain stable', async () => {
  const input = new Uint8Array([123, 125]);
  const { request } = streamed([input]);
  await readBoundedBody(request, 8);
  const owned = bodyBytes(request)!;
  expect(bodyWireBytes(request)).toBe(2);
  input[0] = 0;
  expect([...owned]).toEqual([123, 125]);
});

test('raw mode returns bytes without decoding or parsing JSON', async () => {
  const { request } = streamed([new Uint8Array([0xff, 0x00, 0x7b])]);
  const body = await parseBoundedBody(request, 3, 'raw');
  expect(body).toBeInstanceOf(Uint8Array);
  expect([...(body as Uint8Array)]).toEqual([0xff, 0, 0x7b]);
});

test('a raw route delivers a non-JSON body as bytes without request-path JSON validation', async () => {
  let received: Uint8Array | undefined;
  let receivedWireBytes: number | undefined;
  let receivedOwnedBytes: Uint8Array | undefined;
  const app = createApp({ pool: {} as Pool }).post(
    '/raw-body-probe',
    {
      detail: {
        operationId: 'probe.raw_body',
        hide: true,
        'x-action': 'probe:read',
        'x-body-mode': 'raw',
        'x-exposure': 'public',
        security: [{ bearerAuth: [] }, {}],
      } as never,
    },
    ({ body, request }) => {
      received = body as Uint8Array;
      receivedWireBytes = bodyWireBytes(request);
      receivedOwnedBytes = bodyBytes(request);
      return { size: received.byteLength };
    },
  );
  const response = await app.handle(
    new Request('http://localhost/raw-body-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }),
  );
  expect(response.status).toBe(200);
  expect(received).toBeInstanceOf(Uint8Array);
  expect(receivedWireBytes).toBe(8);
  expect(receivedOwnedBytes).toBe(received);
  expect(new TextDecoder().decode(received)).toBe('not json');
});

test('definition release transport limit is canonical bytes plus the agreed envelope headroom', () => {
  expect(MAX_BODY_LIMIT).toBe(4 * 1024 * 1024 + 65_536);
});

test('body reservations refuse overflow before reading and never exceed the ingress budget', () => {
  const budget = new IngressBodyBudget(10);
  expect(budget.reserve(7)).toBe(true);
  expect(budget.reserve(4)).toBe(false);
  expect(budget.reserved).toBe(7);
  budget.release(7);
  expect(budget.reserved).toBe(0);
});

test('oversized body failures use the existing 413 problem', async () => {
  const source = streamed([new Uint8Array(2)]);
  try {
    await readBoundedBody(source.request, 1);
    throw new Error('expected body limit');
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).code).toBe('content_too_large');
  }
});

const encoder = new TextEncoder();
function rechunk(bytes: Uint8Array, width: number): Uint8Array[] {
  return Array.from({ length: Math.ceil(bytes.length / width) }, (_, i) => bytes.slice(i * width, (i + 1) * width));
}

for (const width of [1, 2, 3, 7, 64]) {
  test(`actual JSON wire preserves decoded names across ${width}-byte chunks`, async () => {
    for (const text of [
      '{"a":1,"a":2}',
      '{"outer":{"":0,"":1}}',
      '[{"x":0,"x":1}]',
      String.raw`{"${'é😀'}":0,"\u00e9\ud83d\ude00":1}`,
      String.raw`{"__proto__":0,"\u005f_proto__":1}`,
    ]) {
      const bytes = encoder.encode(text);
      const { request } = streamed(rechunk(bytes, width));
      await expect(parseBoundedBody(request, bytes.length, 'json')).rejects.toMatchObject({ code: 'invalid_request' });
      expect(bodyWireBytes(request)).toBe(bytes.length);
      expect(bodyBytes(request)).toEqual(bytes);
    }
    const text = String.raw`{"${'é😀'}":1,"${'É😀'}":2,"items":[{"x":0},{"x":1}],"text":"\"},[ {\"a\":1,\"a\":2}"}`;
    const bytes = encoder.encode(text);
    const { request } = streamed(rechunk(bytes, width));
    expect(await parseBoundedBody(request, bytes.length, 'json')).toEqual(JSON.parse(text));
    expect(bodyWireBytes(request)).toBe(bytes.length);
    expect(bodyBytes(request)).toEqual(bytes);
  });
}

test('native syntax, fatal UTF8 and present empty bodies reject with the existing invalid request', async () => {
  for (const bytes of [
    encoder.encode('{"x":'),
    encoder.encode('{} trailing'),
    encoder.encode(''),
    encoder.encode(' '),
    new Uint8Array([0x22, 0xc0, 0xaf, 0x22]),
    new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22]),
    new Uint8Array([0x22, 0xf0, 0x9f, 0x22]),
  ]) {
    const { request } = streamed(rechunk(bytes, 1));
    await expect(parseBoundedBody(request, 64, 'json')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(bodyWireBytes(request)).toBe(bytes.length);
  }
  for (const text of ['null', 'true', '42', '"text"', '[]', '[{},{}]']) {
    const { request } = streamed(rechunk(encoder.encode(text), 1));
    expect(await parseBoundedBody(request, 64, 'json')).toEqual(JSON.parse(text));
  }
});

for (const length of [128, 4096, 65_536]) {
  test(`bounded JSON and raw growth retain exact wire accounting at ${length} bytes`, async () => {
    const positive = encoder.encode(JSON.stringify({ text: 'é'.repeat(length / 2) }));
    const duplicate = encoder.encode('{"x":0,"text":"' + 'é'.repeat(length / 2) + '","x":1}');
    for (const bytes of [positive, duplicate]) {
      for (const width of [1, 127]) {
        const json = streamed(rechunk(bytes, width));
        if (bytes === positive)
          expect(await parseBoundedBody(json.request, bytes.length, 'json')).toEqual(
            JSON.parse(new TextDecoder().decode(bytes)),
          );
        else
          await expect(parseBoundedBody(json.request, bytes.length, 'json')).rejects.toMatchObject({
            code: 'invalid_request',
          });
        expect(bodyWireBytes(json.request)).toBe(bytes.length);
        expect(bodyBytes(json.request)).toEqual(bytes);
        const raw = streamed(rechunk(bytes, width));
        const result = await parseBoundedBody(raw.request, bytes.length, 'raw');
        expect(result).toEqual(bytes);
        expect(result).toBe(bodyBytes(raw.request));
        expect(bodyWireBytes(raw.request)).toBe(bytes.length);
      }
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const nativePool = createPool(databaseUrl);
afterAll(() => nativePool.end());
const writeDetail = {
  operationId: 'probe.strict_json_write',
  'x-action': 'subject:create',
  'x-exposure': 'public',
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }, {}],
};
const writeSchema = t.Object({ value: t.Integer() }, { additionalProperties: false });
function nativeWriteProbe() {
  const limiter = createWriteRateLimiter({
    secret: Bun.randomUUIDv7().repeat(2),
    overrides: JSON.stringify({ anonymous: { write: { maximum: 1, seconds: 60 } } }),
  });
  const spend = spyOn(limiter, 'spend');
  let effects = 0;
  let authenticationRuns = 0;
  const app = createApp({
    pool: nativePool,
    writeRate: limiter,
    ratePeer: () => '192.0.2.44',
    access: (() => {
      authenticationRuns++;
      throw new Error('invalid wire must not reach authentication');
    }) as never,
  }).post('/probe', { body: writeSchema, detail: writeDetail }, ({ body, set, request }) => {
    effects++;
    expect(bodyWireBytes(request)).toBe(bodyBytes(request)!.length);
    set.headers['set-cookie'] = 'probe=effect';
    return body;
  });
  return { app, spend, effects: () => effects, authenticationRuns: () => authenticationRuns };
}

test('mounted writes reject hostile wire before authentication, native write debit, cookies or route effects', async () => {
  const probe = nativeWriteProbe();
  for (const text of [
    '{"value":1,"value":2}',
    String.raw`{"value":1,"\u0076alue":2}`,
    '{"value":{"x":0,"x":1}}',
    '{"value":[{"x":0,"x":1}]}',
    '{"":0,"":1}',
    '{"__proto__":0,"__proto__":1}',
    '{"value":1',
    '{} trailing',
    '',
  ]) {
    const source = streamed(rechunk(encoder.encode(text), 1), { authorization: 'Bearer invalid' });
    const response = await probe.app.handle(source.request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('rezics-session-token')).toBeNull();
  }
  const invalidUtf8 = streamed([new Uint8Array([0xff])], { authorization: 'Bearer invalid' });
  expect((await probe.app.handle(invalidUtf8.request)).status).toBe(400);
  expect(probe.authenticationRuns()).toBe(0);
  expect(probe.spend).not.toHaveBeenCalled();
  expect(probe.effects()).toBe(0);

  const success = await probe.app.handle(streamed(rechunk(encoder.encode('{"value":1}'), 1)).request);
  expect(success.status).toBe(200);
  expect(success.headers.get('set-cookie')).toBe('probe=effect');
  expect(probe.effects()).toBe(1);
  expect(probe.spend).toHaveBeenCalledTimes(1);
  const refused = await probe.app.handle(streamed([encoder.encode('{"value":2}')]).request);
  expect(refused.status).toBe(429);
  expect(await refused.json()).toMatchObject({ code: 'rate_limited', effect_status: 'not_applied' });
  expect(refused.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
  expect(refused.headers.get('set-cookie')).toBeNull();
  expect(probe.effects()).toBe(1);
  expect(probe.spend).toHaveBeenCalledTimes(2);
});

test('mounted required and optional bodies preserve absent versus present empty semantics', async () => {
  const app = createApp({ pool: nativePool });
  const detail = { operationId: 'probe.body_presence', 'x-action': 'probe:read', 'x-exposure': 'public' };
  let effects = 0;
  app.post('/required', { body: writeSchema, detail }, () => ++effects);
  app.post('/optional', { body: t.Optional(writeSchema), detail }, ({ body }) => ({ absent: body === undefined }));
  const absent = (path: string) => new Request(`http://localhost/${path}`, { method: 'POST' });
  const required = await app.handle(absent('required'));
  expect(required.status).toBe(400);
  expect(await required.json()).toMatchObject({ code: 'invalid_request' });
  const optional = await app.handle(absent('optional'));
  expect(optional.status).toBe(200);
  expect(await optional.json()).toEqual({ absent: true });
  for (const path of ['required', 'optional']) {
    const response = await app.handle(
      new Request(`http://localhost/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  }
  expect(effects).toBe(0);
});

// Hold real app readers at capacity; every terminal path must make its slot reusable.
// This exercises the app's private lifecycle rather than inspecting or releasing its budget.
test('mounted reservations release on success, duplicate, syntax, schema and native write-rate refusal', async () => {
  const probe = nativeWriteProbe();
  const budget = (ADMISSION_LIMITS.permits + ADMISSION_LIMITS.queue) * DEFAULT_BODY_LIMIT + 2 * MAX_BODY_LIMIT;
  const capacity = Math.floor(budget / DEFAULT_BODY_LIMIT);
  const held: { controller: ReadableStreamDefaultController<Uint8Array>; response: Promise<Response> }[] = [];
  async function hold() {
    const reading = Promise.withResolvers<void>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          reading.resolve();
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request('http://localhost/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    const response = probe.app.handle(request);
    // An unexpected early response must fail instead of leaving the proof awaiting a reader forever.
    await Promise.race([
      reading.promise,
      response.then((result) => {
        throw new Error(`reader refused: ${result.status}`);
      }),
    ]);
    return { controller, response };
  }
  async function drain(item: (typeof held)[number], text: string) {
    item.controller.enqueue(encoder.encode(text));
    item.controller.close();
    return await item.response;
  }
  try {
    for (let i = 0; i < capacity - 1; i++) held.push(await hold());
    for (const [text, status] of [
      ['{"value":1}', 200],
      ['{"value":1,"value":2}', 400],
      ['{"value":', 400],
      ['{"value":"1"}', 400],
      ['{"value":2}', 429],
    ] as const) {
      const response = await probe.app.handle(streamed([encoder.encode(text)]).request);
      expect(response.status).toBe(status);
      const replacement = await hold();
      held.push(replacement);
      const excess = streamed([encoder.encode('{"value":3}')]);
      const refused = await probe.app.handle(excess.request);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: 'overloaded' });
      expect(excess.reads()).toBe(0);
      expect((await drain(replacement, '{"value":3}')).status).toBe(429);
      held.pop();
    }
    expect(probe.effects()).toBe(1);
    // One success and six ordinary refusals; invalid input never spends a unit.
    expect(probe.spend).toHaveBeenCalledTimes(7);
  } finally {
    for (const item of held) await drain(item, '{"value":');
  }
});

test('mounted raw webhook-style ingress retains duplicate text and non-UTF8 bytes verbatim', async () => {
  let received: unknown;
  let owned: Uint8Array | undefined;
  let count: number | undefined;
  const app = createApp({ pool: nativePool }).post(
    '/raw-wire',
    {
      detail: {
        operationId: 'probe.raw_wire',
        'x-action': 'probe:read',
        'x-exposure': 'public',
        'x-body-mode': 'raw',
        security: [{ bearerAuth: [] }, {}],
      } as never,
    },
    ({ body, request }) => {
      received = body;
      owned = bodyBytes(request);
      count = bodyWireBytes(request);
      return { ok: true };
    },
  );
  const bytes = new Uint8Array([...encoder.encode('{"a":1,"a":2}'), 0xff, 0, 0x0d, 0x0a]);
  for (const width of [1, 3, bytes.length]) {
    const response = await app.handle(
      streamed(rechunk(bytes, width), { 'content-type': 'application/octet-stream' }).request,
    );
    expect(response.status).toBe(200);
    expect(received).toEqual(bytes);
    expect(received).toBe(owned);
    expect(count).toBe(bytes.length);
  }
});
