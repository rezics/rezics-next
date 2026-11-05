import { expect, spyOn, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/client';
import { createImportFetch } from '../services/importer/src/import-fetch';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  type BatchCommand,
  type BatchWriteRequest,
} from '@rezics/definitions/bulk';
import {
  checkMediaImportRequest,
  checkMediaImportStatus,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';
import { loadImportTransport, type TransportOptions } from './imports-transport-driver';

const ORIGIN = 'https://api.example.test';
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CAP = 8192;
const R = 3;
const P = 4;
const DELAY = 250;
const NOW = Date.UTC(2026, 0, 1);
const tuple = { source: 'bangumi', externalId: '1 /?&雪', fieldGroup: 'cover' as const };
const source = {
  source: 'bangumi',
  external_id: '1',
  record_revision: 'unversioned',
  digest: 'a'.repeat(64),
  converter_revision: 'v1',
  field_group: 'facts' as const,
};
function command(index = 0): BatchCommand {
  return {
    op: 'create',
    key: `seed-17-${String(index).padStart(4, '0')}`,
    source: { ...source, external_id: String(index).padStart(4, '0') },
    subject: { type: 'schema:Book', labels: { en: `Book ${String(index).padStart(4, '0')}` } },
  };
}
const body = (): BatchWriteRequest => ({ commands: [command()] });
const receipt = (key = command().key, status: 200 | 201 = 201) => ({
  key,
  status,
  value: { id: SUBJECT, revision: 1 },
});
const ok = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, ...(headers === undefined ? {} : { headers }) });
const success = () => ok({ results: [receipt()] });
function image(): MediaImportRequest {
  return {
    containerId: SUBJECT,
    sourceUrl: 'https://images.example.test/raw-image-sentinel',
    credit: {
      rightsHolder: '(c) rights holder',
      via: { name: 'Bangumi', url: 'https://bgm.tv/subject/1' },
      license: 'LicenseRef-Unknown',
      obligations: [],
    },
    provenance: {
      ...source,
      field_group: 'cover',
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://bgm.tv/subject/1' },
            },
          ],
        },
      ],
    },
  };
}
function status(state: 'reserved' | 'uploaded' | 'available' | 'rejected'): MediaImportStatus {
  const input = image();
  const common = {
    id: MEDIA,
    containerId: SUBJECT,
    purpose: 'cover' as const,
    credit: input.credit,
    provenance: input.provenance,
  };
  if (state === 'reserved' || state === 'rejected')
    return {
      media: {
        ...common,
        state,
        byteCount: null,
        mediaType: null,
        sha256: null,
        ...(state === 'rejected' ? { rejection: { code: 'source_not_allowed' } } : {}),
      },
    };
  return { media: { ...common, state, byteCount: 1024, mediaType: 'image/webp', sha256: 'b'.repeat(64) } };
}
const accepted = () => ok({ media: { id: MEDIA, containerId: SUBJECT, purpose: 'cover', state: 'reserved' } }, 202);
interface Exchange {
  request: Request;
  bytes: Uint8Array;
  json: unknown;
}
/** Fake REMOTE API only. Counters derive from actual fetch callbacks and consumed bodies.
 * No SQL/partitions/index reads occur locally; no claim about server growth or policy.
 * Encode/validate O(bytes+M), rows O(M), R<=5 per batch/fence, media <=P*R.
 * N and U*t are unavailable here. PostgreSQL/shared SQLite proofs belong elsewhere. */
async function setup(
  reply: (exchange: Exchange, index: number) => Response | Promise<Response> = () => success(),
  overrides: Partial<TransportOptions> = {},
) {
  const exchanges: Exchange[] = [];
  const waits: number[] = [];
  const sessions: string[] = [];
  const options: TransportOptions = {
    origin: ORIGIN,
    tokenProvider: async () => 'ordinary-automated-account',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      const exchange = { request, bytes, json: bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null };
      exchanges.push(exchange);
      expect(new URL(request.url).origin).toBe(ORIGIN);
      expect(new URL(request.url).pathname.startsWith('/v1/')).toBe(true);
      expect(request.headers.get('authorization')).toBe('Bearer ordinary-automated-account');
      expect(request.headers.has('cookie')).toBe(false);
      expect(request.redirect).toBe('manual');
      return reply(exchange, exchanges.length - 1);
    }) as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    now: () => NOW,
    maxAttempts: R,
    maxBodyBytes: CAP,
    pollAttempts: P,
    pollDelayMs: DELAY,
    onSession: (token) => {
      sessions.push(token);
    },
    ...overrides,
  };
  return { driver: await loadImportTransport(options), exchanges, waits, sessions };
}
const wire = (exchange: Exchange) => new TextDecoder().decode(exchange.bytes);
function batchRequest(exchange: Exchange, expected: BatchWriteRequest, cap = CAP) {
  expect(exchange.request.method).toBe('POST');
  expect(new URL(exchange.request.url).pathname).toBe('/v1/subjects:batchWrite');
  expect(exchange.json).toEqual(expected);
  expect(checkBatchWrite(exchange.json)).toEqual([]);
  expect(exchange.bytes.length).toBeLessThanOrEqual(cap);
}

test('public bulk transport sends exact portable commands and returns actual UUID acknowledgements', async () => {
  const f = await setup();
  const result = await f.driver.batch(body());
  expect(checkBatchWriteResult(result)).toEqual([]);
  expect(result).toEqual({ results: [receipt()] });
  expect(f.exchanges).toHaveLength(1);
  batchRequest(f.exchanges[0]!, body());
});

test('ordered partial results preserve each command acknowledgement and terminal taken-down 404', async () => {
  const request = { commands: [command(0), command(1), command(2)] };
  const results = [
    receipt(command(0).key),
    { key: command(1).key, status: 404, problem: { type: 'about:blank', title: 'Not found', status: 404 } },
    receipt(command(2).key, 200),
  ];
  const f = await setup(() => ok({ results }));
  expect(await f.driver.batch(request)).toEqual({ results });
  expect(f.exchanges).toHaveLength(1);
  expect(f.waits).toEqual([]);
});

test('entire bulk result rejects malformed missing duplicate unexpected reordered keys counts and statuses', async () => {
  const valid = receipt();
  const invalid: unknown[] = [
    null,
    {},
    { results: [] },
    { results: [valid, valid] },
    { results: [{ ...valid, key: 'unexpected' }] },
    { results: [{ ...valid, status: 202 }] },
    { results: [{ ...valid, value: { id: 'invented-id', revision: 1 } }] },
    { results: [{ ...valid, value: { id: SUBJECT } }] },
    { results: [{ key: valid.key, status: 403 }] },
    { results: [{ ...valid, unexpected: 'hidden malformed data' }] },
  ];
  for (const response of invalid) {
    const f = await setup(() => ok(response));
    await expect(f.driver.batch(body())).rejects.toThrow();
    expect(f.exchanges).toHaveLength(1);
  }
  const f = await setup(() => ok({ results: [receipt(command(1).key), receipt(command(0).key)] }));
  await expect(f.driver.batch({ commands: [command(0), command(1)] })).rejects.toThrow();
});

test('HTTP 200 invalid JSON never acknowledges a command', async () => {
  const f = await setup(() => new Response('not-json', { status: 200 }));
  await expect(f.driver.batch(body())).rejects.toThrow();
  expect(f.exchanges).toHaveLength(1);
});

test('create or resolve consumes first 201 and replay 200 identities without substituting changed bodies', async () => {
  const f = await setup((exchange, index) => {
    if (index < 2) return ok({ results: [receipt(command().key, index === 0 ? 201 : 200)] });
    expect(exchange.json).toEqual(changed);
    return ok({ title: 'Idempotency conflict', status: 409 }, 409);
  });
  const changed = body();
  if (changed.commands[0]!.op === 'create') changed.commands[0]!.subject.labels.en = 'Changed';
  expect(await f.driver.batch(body())).toEqual({ results: [receipt()] });
  expect(await f.driver.batch(body())).toEqual({ results: [receipt(command().key, 200)] });
  await expect(f.driver.batch(changed)).rejects.toThrow();
  expect(f.exchanges.length).toBeGreaterThanOrEqual(2);
  expect(wire(f.exchanges[0]!)).toBe(wire(f.exchanges[1]!));
  expect(f.exchanges.length).toBeLessThanOrEqual(3);
});

test('portable rights document media and command caps reject before any HTTP request', async () => {
  const f = await setup();
  const proposal = {
    op: 'propose',
    key: 'summary',
    source: { ...source, field_group: 'summary' },
    subject: SUBJECT,
    statement: {
      property: { id: 'schema:abstract' },
      value: { type: 'value', content: { language: 'en', document: { invalid: true } } },
      references: image().provenance.references,
    },
    rights: { license: 'made-up-permissive', obligations: [], attribution: '' },
  };
  const invalid: unknown[] = [
    { commands: [] },
    { commands: Array.from({ length: 101 }, (_, i) => command(i)) },
    { commands: [command(), command()] },
    { commands: [proposal] },
    {
      commands: [
        {
          ...proposal,
          source: { ...source, field_group: 'cover' },
          statement: {
            ...proposal.statement,
            property: { id: 'schema:image' },
            value: { type: 'value', content: 'fake-media' },
          },
        },
      ],
    },
  ];
  for (const input of invalid) {
    expect(checkBatchWrite(input).length).toBeGreaterThan(0);
    await expect(f.driver.batch(input as BatchWriteRequest)).rejects.toThrow();
  }
  expect(f.exchanges).toEqual([]);
});

test('hard UTF8 body cap includes document bytes and rejects oversize single request before fetch', async () => {
  const f = await setup();
  const huge = command();
  if (huge.op === 'create') huge.subject.labels.en = '雪'.repeat(CAP);
  await expect(f.driver.batch({ commands: [huge] })).rejects.toThrow();
  expect(f.exchanges).toEqual([]);
});

test('document serialization is included in request cap and portable snapshot limit before sending', async () => {
  const f = await setup();
  const summary = (text: string): BatchCommand => ({
    op: 'propose',
    key: 'summary',
    subject: SUBJECT,
    source: { ...source, field_group: 'summary' },
    statement: {
      property: { id: 'schema:abstract' },
      value: {
        type: 'value',
        content: {
          language: 'en',
          document: {
            version: 'rezics-document-v1',
            profile: 'text',
            doc: {
              type: 'doc',
              content: [{ type: 'paragraph', attrs: { id: 'summary-paragraph' }, content: [{ type: 'text', text }] }],
            },
          },
        },
      },
      references: image().provenance.references,
    },
    rights: {
      license: 'CC-BY-SA-3.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
      attribution: 'Bangumi contributors',
    },
  });
  const request = { commands: [summary('雪'.repeat(3000))] };
  expect(checkBatchWrite(request)).toEqual([]);
  await expect(f.driver.batch(request)).rejects.toThrow();
  const oversized = { commands: [summary('雪'.repeat(12000))] };
  expect(checkBatchWrite(oversized).length).toBeGreaterThan(0);
  await expect(f.driver.batch(oversized)).rejects.toThrow();
  expect(f.exchanges).toEqual([]);
});

test('batching owner splits by count and bytes without losing commands', async () => {
  const f = await setup((exchange) => {
    const request = exchange.json as BatchWriteRequest;
    batchRequest(exchange, request);
    return ok({ results: request.commands.map((c) => receipt(c.key)) });
  });
  const commands = Array.from({ length: 201 }, (_, i) => {
    const c = command(i);
    if (c.op === 'create') c.subject.labels.en = '雪'.repeat(120);
    return c;
  });
  const results = await f.driver.batches(commands);
  expect(f.exchanges.length).toBeGreaterThan(3);
  expect(f.exchanges.flatMap((e) => (e.json as BatchWriteRequest).commands)).toEqual(commands);
  expect(results.flatMap((r) => r.results).map((r) => r.key)).toEqual(commands.map((c) => c.key));
});

test('429 exact seconds and HTTP date Retry-After preserve bytes and command keys', async () => {
  for (const header of ['7', 'Thu, 01 Jan 2026 00:00:07 GMT']) {
    const f = await setup((_, i) => (i === 0 ? ok({}, 429, { 'retry-after': header }) : success()));
    await f.driver.batch(body());
    expect(f.waits).toEqual([7000]);
    expect(f.exchanges).toHaveLength(2);
    expect(wire(f.exchanges[0]!)).toBe(wire(f.exchanges[1]!));
  }
});

test('5xx and network retries use bounded existing adapter backoff without hotloop', async () => {
  for (const failure of ['network', 'server']) {
    const f = await setup((_, i) => {
      if (i === R - 1) return success();
      if (failure === 'network') throw new TypeError('offline');
      return ok({}, 503);
    });
    await f.driver.batch(body());
    expect(f.exchanges).toHaveLength(R);
    expect(f.waits).toEqual([1000, 2000]);
    expect(new Set(f.exchanges.map(wire)).size).toBe(1);
  }
  const f = await setup(() => ok({}, 503));
  await expect(f.driver.batch(body())).rejects.toThrow();
  expect(f.exchanges).toHaveLength(R);
  expect(f.waits).toEqual([1000, 2000]);
});

test('401 403 404 and validation failures are terminal with no retry', async () => {
  for (const code of [400, 401, 403, 404, 422]) {
    const f = await setup(() => ok({ title: 'terminal', status: code }, code));
    await expect(f.driver.batch(body())).rejects.toThrow();
    expect(f.exchanges).toHaveLength(1);
    expect(f.waits).toEqual([]);
  }
});

test('cancellation stops in retry sleep and before initial request', async () => {
  const controller = new AbortController();
  const f = await setup(() => ok({}, 503), {
    sleep: async () => {
      controller.abort();
    },
  });
  await expect(f.driver.batch(body(), controller.signal)).rejects.toThrow();
  expect(f.exchanges).toHaveLength(1);
  await expect(f.driver.batch(body(), controller.signal)).rejects.toThrow();
  expect(f.exchanges).toHaveLength(1);
});

test('redirects never forward credentials and bearer acquisition is through actual tokenProvider', async () => {
  let calls = 0;
  const f = await setup(
    () =>
      new Response(null, { status: 307, headers: { location: 'https://evil.example.test/v1/subjects:batchWrite' } }),
    {
      tokenProvider: async () => {
        calls++;
        return 'ordinary-automated-account';
      },
    },
  );
  await expect(f.driver.batch(body())).rejects.toThrow();
  expect(calls).toBe(1);
  expect(f.exchanges).toHaveLength(1);
});

test('origin and v1 constraints reject invalid configuration before token acquisition or fetch', async () => {
  await setup();
  for (const origin of [
    `${ORIGIN}/v1`,
    `${ORIGIN}/other`,
    'https://user:password@api.example.test',
    `${ORIGIN}?x=1`,
    'file:///v1/',
  ]) {
    let tokens = 0;
    let requests = 0;
    await expect(
      setup(
        () => {
          requests++;
          return success();
        },
        {
          origin,
          tokenProvider: async () => {
            tokens++;
            return 'private';
          },
        },
      ),
    ).rejects.toThrow();
    expect(tokens).toBe(0);
    expect(requests).toBe(0);
  }
});

test('exact API origin and v1 path guard reject foreign lookalike and non-v1 destinations before bearer attachment', async () => {
  await setup();
  let tokens = 0;
  let requests = 0;
  const transport = createImportFetch({
    origin: ORIGIN,
    token: async () => {
      tokens++;
      return 'private';
    },
    fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      requests++;
      return success();
    }) as typeof fetch,
  });
  for (const url of [
    'https://evil.example.test/v1/media:importFromUrl',
    'https://api.example.test.evil.test/v1/subjects:batchWrite',
    `${ORIGIN}:444/v1/subjects:batchWrite`,
    `${ORIGIN}/v10/subjects:batchWrite`,
    `${ORIGIN}/v1`,
    `${ORIGIN}/v1/../private`,
    'https://user:password@api.example.test/v1/subjects:batchWrite',
  ]) {
    await expect(transport(url)).rejects.toThrow();
  }
  expect(tokens).toBe(0);
  expect(requests).toBe(0);
});

test('actual kernel client carries rotated session response headers between requests', async () => {
  const f = await setup(
    (exchange, index) => {
      expect(exchange.request.headers.get(SESSION_HEADER)).toBe(index === 0 ? 'initial-session' : 'next-session');
      return ok({ results: [receipt()] }, 200, { [SESSION_HEADER]: 'next-session' });
    },
    { session: 'initial-session' },
  );
  await f.driver.batch(body());
  await f.driver.batch(body());
  expect(f.sessions).toEqual(['next-session']);
  expect(f.exchanges).toHaveLength(2);
});

test('fence exact tuple query is authenticated and each refresh performs a new lookup', async () => {
  const f = await setup((exchange) => {
    const url = new URL(exchange.request.url);
    expect(exchange.request.method).toBe('GET');
    expect(url.pathname).toBe('/v1/sourceFences:check');
    expect([...url.searchParams.entries()].sort()).toEqual(Object.entries(tuple).sort());
    return ok({ fenced: true, securityRevision: 'security-17' });
  });
  for (let i = 0; i < 2; i++)
    expect(await f.driver.refreshCover(tuple, image(), 'cover-key')).toEqual({ outcome: 'fenced' });
  expect(f.exchanges).toHaveLength(2);
});

test('later takedown refresh performs fresh fence lookup and prevents next media upload', async () => {
  let checks = 0;
  let uploads = 0;
  const f = await setup((exchange) => {
    const path = new URL(exchange.request.url).pathname;
    if (path === '/v1/sourceFences:check') {
      checks++;
      return ok({ fenced: checks > 1, securityRevision: checks > 1 ? String(checks) : null });
    }
    if (path === '/v1/media:importFromUrl') {
      uploads++;
      return accepted();
    }
    expect(path).toBe(`/v1/media/${MEDIA}:importStatus`);
    return ok(status('available'));
  });
  expect(await f.driver.refreshCover(tuple, image(), 'first')).toEqual({
    outcome: 'available',
    id: MEDIA,
    status: status('available'),
  });
  expect(await f.driver.refreshCover(tuple, image(), 'next')).toEqual({ outcome: 'fenced' });
  expect(checks).toBe(2);
  expect(uploads).toBe(1);
  expect(f.exchanges).toHaveLength(4);
});

test('fence nullable revision is preserved and malformed or denied lookup never falls back anonymously', async () => {
  const f = await setup(() => ok({ fenced: false, securityRevision: null }));
  expect(await f.driver.fence(tuple)).toEqual({ fenced: false, securityRevision: null });
  for (const reply of [
    () => ok({ fenced: false }),
    () => ok({ fenced: 'false', securityRevision: 1 }),
    () => ok({}, 401),
    () => ok({}, 403),
    () => ok({}, 404),
  ]) {
    const denied = await setup(reply);
    await expect(denied.driver.refreshCover(tuple, image(), 'key')).rejects.toThrow();
    expect(denied.exchanges).toHaveLength(1);
    expect(denied.waits).toEqual([]);
  }
});

test('media POST202 uses actual portable credit provenance container and idempotency then measured status', async () => {
  const states = ['reserved', 'uploaded', 'available'] as const;
  const f = await setup((exchange, index) => {
    const url = new URL(exchange.request.url);
    if (index === 0) {
      expect(url.pathname).toBe('/v1/media:importFromUrl');
      expect(exchange.request.method).toBe('POST');
      expect(exchange.request.headers.get('idempotency-key')).toBe('"cover-key"');
      expect(exchange.json).toEqual(image());
      expect(checkMediaImportRequest(exchange.json)).toEqual([]);
      return accepted();
    }
    expect(url.pathname).toBe(`/v1/media/${MEDIA}:importStatus`);
    expect(exchange.request.method).toBe('GET');
    expect(exchange.bytes.length).toBe(0);
    return ok(status(states[index - 1]!));
  });
  const result = await f.driver.media(image(), 'cover-key');
  expect(result).toEqual({ outcome: 'available', id: MEDIA, status: status('available') });
  expect(checkMediaImportStatus(status('available'))).toEqual([]);
  expect(f.waits).toEqual([DELAY, DELAY]);
  expect(f.exchanges).toHaveLength(4);
});

test('media retries preserve idempotency body and terminal status authorization failures never repoll', async () => {
  const f = await setup((_, index) => (index === 0 ? ok({}, 503) : index === 1 ? accepted() : ok(status('available'))));
  await f.driver.media(image(), 'stable-media');
  expect(wire(f.exchanges[0]!)).toBe(wire(f.exchanges[1]!));
  expect(f.exchanges[0]!.request.headers.get('idempotency-key')).toBe('"stable-media"');
  expect(f.exchanges[1]!.request.headers.get('idempotency-key')).toBe('"stable-media"');
  expect(f.waits).toEqual([1000]);
  for (const code of [401, 403, 404]) {
    const denied = await setup((_, index) => (index === 0 ? accepted() : ok({}, code)));
    await expect(denied.driver.media(image(), 'denied')).rejects.toThrow();
    expect(denied.exchanges).toHaveLength(2);
    expect(denied.waits).toEqual([]);
  }
});

test('reserved and uploaded remain bounded pending without cover binding UUID or baseline completion', async () => {
  for (const state of ['reserved', 'uploaded'] as const) {
    const f = await setup((_, index) => (index === 0 ? accepted() : ok(status(state))));
    const result = await f.driver.media(image(), 'pending');
    expect(result).toEqual({ outcome: 'pending', status: status(state) });
    expect(Object.hasOwn(result, 'id')).toBe(false);
    expect(f.exchanges).toHaveLength(1 + P);
    expect(f.waits).toEqual(Array(P - 1).fill(DELAY));
    expect(f.exchanges.every((e) => !e.request.url.includes('baseline'))).toBe(true);
  }
});

test('rejected media returns only safe terminal code and stops polling', async () => {
  const f = await setup((_, i) => (i === 0 ? accepted() : ok(status('rejected'))));
  expect(await f.driver.media(image(), 'rejected')).toEqual({
    outcome: 'rejected',
    code: 'source_not_allowed',
    status: status('rejected'),
  });
  expect(f.exchanges).toHaveLength(2);
  expect(f.waits).toEqual([]);
});

test('media rejects mismatched id container purpose provenance credit and malformed measured status', async () => {
  const valid = status('available');
  const invalid = [
    null,
    {},
    { media: { ...valid.media, id: OTHER } },
    { media: { ...valid.media, containerId: OTHER } },
    { media: { ...valid.media, purpose: 'avatar' } },
    { media: { ...valid.media, provenance: { ...valid.media.provenance, external_id: 'other' } } },
    { media: { ...valid.media, credit: { ...valid.media.credit, license: 'CC0-1.0' } } },
    { media: { ...valid.media, byteCount: null } },
    { media: { ...valid.media, sha256: 'bad' } },
    { media: { ...valid.media, state: 'complete' } },
    { media: { ...valid.media, sourceUrl: image().sourceUrl } },
  ];
  for (const value of invalid) {
    const f = await setup((_, i) => (i === 0 ? accepted() : ok(value)));
    await expect(f.driver.media(image(), 'invalid')).rejects.toThrow();
    expect(f.exchanges).toHaveLength(2);
    expect(f.waits).toEqual([]);
  }
});

test('media rejects malformed 202 receipt and portable input before polling or sending', async () => {
  for (const media of [
    { id: OTHER, containerId: OTHER, purpose: 'cover', state: 'reserved' },
    { id: MEDIA, containerId: SUBJECT, purpose: 'cover', state: 'available' },
    {},
  ]) {
    const f = await setup(() => ok({ media }, 202));
    await expect(f.driver.media(image(), 'bad-receipt')).rejects.toThrow();
    expect(f.exchanges).toHaveLength(1);
  }
  const f = await setup();
  for (const input of [
    { ...image(), containerId: 'unresolved' },
    { ...image(), sourceUrl: 'http://unsafe.test/a' },
    { ...image(), credit: { ...image().credit, obligations: ['invented'] } },
  ]) {
    expect(checkMediaImportRequest(input).length).toBeGreaterThan(0);
    await expect(f.driver.media(input as MediaImportRequest, 'invalid')).rejects.toThrow();
  }
  expect(f.exchanges).toEqual([]);
});

test('media polling cancellation and retry budgets remain bounded', async () => {
  const controller = new AbortController();
  const f = await setup((_, i) => (i === 0 ? accepted() : ok(status('reserved'))), {
    sleep: async () => {
      controller.abort();
    },
  });
  await expect(f.driver.media(image(), 'cancel', controller.signal)).rejects.toThrow();
  expect(f.exchanges).toHaveLength(2);
  const failed = await setup((_, i) => (i === 0 ? accepted() : ok({}, 503)));
  await expect(failed.driver.media(image(), 'failed')).rejects.toThrow();
  expect(failed.exchanges).toHaveLength(1 + R);
  expect(failed.waits).toEqual([1000, 2000]);
});

test('raw source image sentinels never trigger byte relay website complete or grant requests', async () => {
  const f = await setup((exchange) => {
    expect(exchange.request.url).toBe(`${ORIGIN}/v1/media:importFromUrl`);
    expect(exchange.json).toEqual(image());
    expect(wire(exchange)).not.toContain('RAW_IMAGE_BYTES_SENTINEL');
    return ok({}, 403);
  });
  await expect(f.driver.media(image(), 'privacy')).rejects.toThrow();
  expect(f.exchanges).toHaveLength(1);
});

test('privacy never logs bearer tokens or consumes raw image sentinels via global fetch', async () => {
  const f = await setup((_, index) => (index === 0 ? accepted() : ok(status('available'))));
  const logs: unknown[][] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    }),
  );
  let sourceFetches = 0;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => {
    sourceFetches++;
    return new Response('RAW_IMAGE_BYTES_SENTINEL');
  }) as typeof fetch);
  try {
    await f.driver.media(image(), 'privacy');
    expect(sourceFetches).toBe(0);
    expect(JSON.stringify(logs)).not.toContain('ordinary-automated-account');
    expect(f.exchanges).toHaveLength(2);
  } finally {
    fetchSpy.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
});

test('one deterministic seed scales 1 8 64 measure actual requests UTF8 bytes and returned items', async () => {
  const samples: { scale: number; requests: number; bytes: number; items: number }[] = [];
  for (const scale of [1, 8, 64]) {
    const f = await setup(
      (exchange) => {
        const request = exchange.json as BatchWriteRequest;
        batchRequest(exchange, request, 128 * 1024);
        return ok({ results: request.commands.map((c) => receipt(c.key)) });
      },
      { maxBodyBytes: 128 * 1024 },
    );
    // One seed, fixed-width payloads; no N/history, timers, SQL or fabricated counters.
    const request = { commands: Array.from({ length: scale }, (_, i) => command(i)) };
    const result = await f.driver.batch(request);
    expect(checkBatchWriteResult(result)).toEqual([]);
    expect(result.results.map((r) => r.key)).toEqual(request.commands.map((c) => c.key));
    samples.push({
      scale,
      requests: f.exchanges.length,
      bytes: f.exchanges.reduce((sum, e) => sum + e.bytes.length, 0),
      items: result.results.length,
    });
  }
  expect(samples.map((s) => s.requests)).toEqual([1, 1, 1]);
  expect(samples.map((s) => s.items)).toEqual([1, 8, 64]);
  const envelope = new TextEncoder().encode('{"commands":[]}').length;
  const unit = samples[0]!.bytes - envelope + 1;
  for (const sample of samples) expect(sample.bytes).toBe(envelope + unit * sample.scale - 1);
});
