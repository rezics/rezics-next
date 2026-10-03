import { afterEach, expect, spyOn, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import {
  ADDRESS_CACHE_LIMITS,
  readAddress,
  type ResolvedAddress,
} from '../features/address/client.ts';

const uuid = 'dfc1030e-efa0-4041-a686-bebce31f645c';
const originalFetch = globalThis.fetch;
let ordinal = 0;
let now = 1_800_000_000_000;
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clock?.mockRestore();
  clock = undefined;
});

function fixture() {
  now = 1_800_000_000_000;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  const origin = `https://g-1003-cache-${++ordinal}.test`;
  const calls: Array<{ url: URL; headers: Headers }> = [];
  let respond: (url: URL, headers: Headers) => Response = (url) =>
    hit(url.searchParams.get('key')!);
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    expect(init?.cache).toBe('no-store');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    return respond(url, headers);
  }) as typeof fetch;
  return {
    origin,
    calls,
    respond: (next: typeof respond) => {
      respond = next;
    },
    read: (key = 'reader', language = 'en', incoming?: Headers) =>
      readAddress({ scope: 'agent', key }, language, origin, incoming),
  };
}

function data(key: string, canonicalKey = uuidToSid(uuid)): ResolvedAddress {
  return {
    profile: 'address-resolution-v1',
    status: 'resolved',
    scope: 'agent',
    key,
    holder: `https://rezics.com/id/${uuid}`,
    state: 'current',
    canonical: { prefix: '/a/', key: canonicalKey, slugSource: 'Reader' },
  };
}
function hit(key: string, canonicalKey?: string, headers: HeadersInit = {}) {
  return Response.json(data(key, canonicalKey), {
    headers: {
      'cache-control': 'public, max-age=30, must-revalidate',
      etag: '"revision-1"',
      vary: 'Authorization, Accept-Language, X-Rezics-Display-Languages',
      ...headers,
    },
  });
}

test('G1003: anonymous public hits share freshness across clients and isolate caller mutations', async () => {
  const f = fixture();
  const first = await f.read(
    'reader',
    'en',
    new Headers({ 'cf-connecting-ip': '203.0.113.17', cookie: 'secret=one' }),
  );
  expect(first.kind).toBe('resolved');
  if (first.kind === 'resolved') first.data.canonical.key = 'caller-mutated';
  now += 29_999;
  const second = await f.read(
    'reader',
    'en',
    new Headers({ 'cf-connecting-ip': '203.0.113.18', authorization: 'Bearer private' }),
  );
  expect(second).toMatchObject({ kind: 'resolved', data: { canonical: { key: uuidToSid(uuid) } } });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.headers.get('x-rezics-client-ip')).toBe('203.0.113.17');
});

test('G1003: at expiry Main receives the ETag and a rename replaces the cached canonical address', async () => {
  const f = fixture();
  await f.read();
  now += 30_000;
  f.respond((_url, headers) => {
    expect(headers.get('if-none-match')).toBe('"revision-1"');
    return hit('reader', 'renamed-reader', { etag: '"revision-2"' });
  });
  expect(await f.read()).toMatchObject({
    kind: 'resolved',
    data: { canonical: { key: 'renamed-reader' } },
  });
  await f.read();
  expect(f.calls).toHaveLength(2);
});

test('G1003: 304 renews only validated data and retains or replaces its validator', async () => {
  const f = fixture();
  await f.read();
  now += 30_000;
  f.respond(() => new Response(null, { status: 304, headers: { etag: '"revision-1b"' } }));
  expect((await f.read()).kind).toBe('resolved');
  now += 29_999;
  expect((await f.read()).kind).toBe('resolved');
  expect(f.calls).toHaveLength(2);
  now += 1;
  f.respond((_url, headers) => {
    expect(headers.get('if-none-match')).toBe('"revision-1b"');
    return new Response(null, { status: 304, headers: { 'cache-control': 'no-store' } });
  });
  expect((await f.read()).kind).toBe('resolved');
  f.respond((_url, headers) => {
    expect(headers.has('if-none-match')).toBe(false);
    return hit('reader');
  });
  await f.read();
  expect(f.calls).toHaveLength(4);
});

test('G1003: language, origin, scope and Zone route select independent cache entries', async () => {
  const f = fixture();
  f.respond((url, headers) => {
    const value = {
      ...data(url.searchParams.get('key')!),
      scope: url.searchParams.get('scope'),
      canonical: {
        prefix: '/a/',
        key: uuidToSid(uuid),
        slugSource: headers.get('accept-language'),
      },
    };
    return Response.json(value, {
      headers: { 'cache-control': 'public, max-age=30', etag: '"revision"' },
    });
  });
  for (const language of ['en', 'sv']) {
    expect(await f.read('reader', language)).toMatchObject({
      data: { canonical: { slugSource: language } },
    });
    await f.read('reader', language);
  }
  await readAddress({ scope: 'agent', key: 'reader' }, 'en', `${f.origin}/other`);
  for (const scope of ['work', `zone:https://rezics.com/id/${uuid}`] as const) {
    for (const route of ['first', 'second']) {
      const lookup = { scope, key: 'reader', route };
      await readAddress(lookup, 'en', f.origin);
      await readAddress(lookup, 'en', f.origin);
    }
  }
  expect(f.calls).toHaveLength(7);
});

test('G1003: entry capacity evicts the least recently used hit', async () => {
  const f = fixture();
  for (let i = 0; i < ADDRESS_CACHE_LIMITS.entries; i++) await f.read(`reader-${i}`);
  await f.read('reader-0');
  await f.read('reader-overflow');
  await f.read('reader-0');
  expect(f.calls).toHaveLength(ADDRESS_CACHE_LIMITS.entries + 1);
  await f.read('reader-1');
  expect(f.calls).toHaveLength(ADDRESS_CACHE_LIMITS.entries + 2);
});

test('G1003: oversized values and cache keys never occupy cache capacity', async () => {
  const f = fixture();
  f.respond((url) =>
    Response.json(
      {
        ...data(url.searchParams.get('key')!),
        canonical: {
          ...data('reader').canonical,
          slugSource: '界'.repeat(ADDRESS_CACHE_LIMITS.entryBytes),
        },
      },
      { headers: { 'cache-control': 'public, max-age=30', etag: '"revision"' } },
    ),
  );
  await f.read();
  await f.read();
  f.respond((url) => hit(url.searchParams.get('key')!));
  const language = 'en,'.repeat(ADDRESS_CACHE_LIMITS.keyLength);
  await f.read('long-key', language);
  await f.read('long-key', language);
  expect(f.calls).toHaveLength(4);
});

const uncacheablePolicies: Record<string, string>[] = [
  { 'cache-control': 'no-store' },
  { 'cache-control': 'private, max-age=30' },
  { 'cache-control': 'max-age=30' },
  { 'cache-control': 'public, max-age=invalid' },
  { vary: '*' },
  { vary: 'Cookie' },
  { etag: '' },
];
test.each(uncacheablePolicies)(
  'G1003: non-public or unsupported cache policy %j cannot be reused',
  async (headers) => {
    const f = fixture();
    f.respond(() => hit('reader', undefined, headers));
    await f.read();
    await f.read();
    expect(f.calls).toHaveLength(2);
  },
);

test('G1003: Age, Date and response delay consume freshness and s-maxage wins for a shared cache', async () => {
  const f = fixture();
  f.respond(() => {
    now += 1000;
    return hit('reader', undefined, {
      'cache-control': 'public, max-age=30, s-maxage=10',
      age: '5',
      date: new Date(now - 8000).toUTCString(),
    });
  });
  await f.read();
  now += 1999;
  await f.read();
  expect(f.calls).toHaveLength(1);
  now += 1;
  await f.read();
  expect(f.calls).toHaveLength(2);
});

test('G1003: no-cache and zero max-age retain a validator but always revalidate', async () => {
  for (const policy of ['public, no-cache, max-age=30', 'public, max-age=0']) {
    const f = fixture();
    f.respond(() => hit('reader', undefined, { 'cache-control': policy }));
    await f.read();
    await f.read();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.headers.get('if-none-match')).toBe('"revision-1"');
    clock?.mockRestore();
  }
});

test.each([400, 404, 410, 429, 503])(
  'G1003: status %s invalidates an expired hit and is never cached as success',
  async (status) => {
    const f = fixture();
    await f.read();
    now += 30_000;
    f.respond(
      () =>
        new Response(null, {
          status,
          headers: { 'cache-control': 'public, max-age=30', etag: '"miss"' },
        }),
    );
    expect((await f.read()).kind).toBe(
      status === 410 ? 'retired' : status >= 429 ? 'unavailable' : 'missing',
    );
    await f.read();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.headers.has('if-none-match')).toBe(false);
    f.respond(() => hit('reader', 'recovered'));
    expect(await f.read()).toMatchObject({
      kind: 'resolved',
      data: { canonical: { key: 'recovered' } },
    });
  },
);

test('G1003: malformed answers and unsolicited 304 never seed a hit', async () => {
  const f = fixture();
  for (const response of [
    () => Response.json({ ...data('reader'), canonical: { key: uuid } }),
    () => new Response(null, { status: 304 }),
  ]) {
    f.respond(response);
    expect((await f.read()).kind).toBe('unavailable');
    expect((await f.read()).kind).toBe('unavailable');
  }
  expect(f.calls).toHaveLength(4);
});

test('G1003: an answer with a different lookup key cannot seed the requested cache entry', async () => {
  const f = fixture();
  f.respond(() => hit('different-reader'));
  expect((await f.read()).kind).toBe('resolved');
  expect((await f.read()).kind).toBe('resolved');
  expect(f.calls).toHaveLength(2);
});

test('G1003: an expired hit is never served through an outage or a timeout', async () => {
  const f = fixture();
  await f.read();
  now += 30_000;
  f.respond(() => {
    throw new DOMException('Timed out', 'TimeoutError');
  });
  expect((await f.read()).kind).toBe('unavailable');
  f.respond(() => new Response(null, { status: 503 }));
  expect((await f.read()).kind).toBe('unavailable');
});
