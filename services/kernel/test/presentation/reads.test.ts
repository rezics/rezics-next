import { expect, test } from 'bun:test';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { MAX_PAGE_READS, PageReadError, readPage } from '../../src/presentation/reads.ts';
import { decodeSession, encodeSession } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const scope = 'account:019a1b2c-3d4e-7f00-8a00-5ab1ec700001';
const book = '018f0000-0000-7000-8000-00a000000001';
const merged = '018f0000-0000-7000-8000-00a000000002';
const survivor = '018f0000-0000-7000-8000-00a000000003';
const missing = '018f0000-0000-7000-8000-00a000000004';
const asOf = '2026-10-25T00:00:00.000Z';
const notFound = {
  type: 'https://rezics.com/problems/not_found',
  title: 'Not Found',
  status: 404,
  code: 'not_found',
};
const empty = { subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: asOf };

type Seen = { method: string; path: string; headers: Record<string, string>; body: unknown };

function fakeKernel() {
  const seen: Seen[] = [];
  let active = 0;
  let peak = 0;
  const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
    });
  const dispatch = async (request: Request): Promise<Response> => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await Bun.sleep(5);
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: request.method === 'POST' ? await request.json() : undefined,
      });
      if (url.origin !== 'http://kernel.test') return json(404, notFound);
      if (url.pathname === `/v1/subjects/${book}`)
        return json(
          200,
          { subject: { id: book }, related: {} },
          { [SESSION_HEADER]: encodeSession(ring, scope, [{ partition: 7, epoch: 1, position: 40n }]) },
        );
      if (url.pathname === `/v1/subjects/${merged}`)
        return new Response(null, { status: 308, headers: { location: `/v1/subjects/${survivor}` } });
      if (url.pathname === `/v1/subjects/${survivor}`) return json(200, { subject: { id: survivor }, related: {} });
      if (url.pathname === '/v1/subjects:search' && request.method === 'POST')
        return json(200, empty, {
          [SESSION_HEADER]: encodeSession(ring, scope, [{ partition: 9, epoch: 2, position: 5n }]),
        });
      return json(404, notFound);
    } finally {
      active -= 1;
    }
  };
  return { seen, dispatch, peak: () => peak };
}

const callerToken = encodeSession(ring, scope, [
  { partition: 7, epoch: 1, position: 30n },
  { partition: 3, epoch: 1, position: 1n },
]);
const incoming = () =>
  new Request('http://kernel.test/v1/pages:read', {
    method: 'POST',
    headers: {
      authorization: 'Bearer reader',
      [SESSION_HEADER]: callerToken,
      cookie: 'session=secret',
      'idempotency-key': '"page"',
      'x-forwarded-for': '203.0.113.9',
      'content-type': 'application/json',
    },
  });
const search = { filter: { statement: { property: 'schema:author', in: [book] } }, sort: 'name', limit: 12 };

test("each read runs through its standalone route with only the caller's credentials", async () => {
  const kernel = fakeKernel();
  const { results } = await readPage({
    dispatch: kernel.dispatch,
    incoming: incoming(),
    reads: {
      book: { kind: 'subject', id: book },
      works: { kind: 'search', body: search },
      gone: { kind: 'subject', id: missing },
    },
    session: { ring, scope },
  });
  expect(results).toEqual({
    book: { status: 200, body: { subject: { id: book }, related: {} } },
    works: { status: 200, body: empty },
    gone: { status: 404, body: notFound },
  });
  expect(kernel.seen.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
    `GET /v1/subjects/${book}`,
    `GET /v1/subjects/${missing}`,
    'POST /v1/subjects:search',
  ]);
  for (const request of kernel.seen) {
    expect(request.headers.authorization).toBe('Bearer reader');
    expect(request.headers[SESSION_HEADER]).toBe(callerToken);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers['idempotency-key']).toBeUndefined();
    expect(request.headers['x-forwarded-for']).toBeUndefined();
  }
  const posted = kernel.seen.find(({ method }) => method === 'POST')!;
  expect(posted.body).toEqual(search);
  expect(posted.headers['content-type']).toBe('application/json');

  const anonymous = fakeKernel();
  await readPage({
    dispatch: anonymous.dispatch,
    incoming: new Request('http://kernel.test/v1/pages:read', { method: 'POST' }),
    reads: { book: { kind: 'subject', id: book } },
    session: { ring, scope: 'anonymous' },
  });
  expect(anonymous.seen[0]!.headers.authorization).toBeUndefined();
  expect(anonymous.seen[0]!.headers[SESSION_HEADER]).toBeUndefined();
});

test('a merged subject is followed once to its survivor', async () => {
  const kernel = fakeKernel();
  const { results } = await readPage({
    dispatch: kernel.dispatch,
    incoming: incoming(),
    reads: { old: { kind: 'subject', id: merged } },
    session: { ring, scope },
  });
  expect(results).toEqual({ old: { status: 200, body: { subject: { id: survivor }, related: {} } } });
  expect(kernel.seen.map(({ path }) => path)).toEqual([`/v1/subjects/${merged}`, `/v1/subjects/${survivor}`]);
});

test('links, collections and reactions dispatch through their standalone subject routes', async () => {
  const kernel = fakeKernel();
  await readPage({
    dispatch: kernel.dispatch,
    incoming: incoming(),
    reads: {
      links: {
        kind: 'links',
        id: book,
        property: 'schema:author',
        filter: merged,
        type: 'schema:Person',
        limit: 12,
      },
      collections: { kind: 'collections', id: book, limit: 6 },
      reactions: { kind: 'reactions', id: book },
    },
    session: { ring, scope },
  });
  expect(kernel.seen.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
    `GET /v1/subjects/${book}/collections?limit=6`,
    `GET /v1/subjects/${book}/links?property=schema%3Aauthor&filter=${merged}&type=schema%3APerson&limit=12`,
    `GET /v1/subjects/${book}/reactions`,
  ]);
});

test("session tokens from every read are merged with the caller's", async () => {
  const kernel = fakeKernel();
  const { session } = await readPage({
    dispatch: kernel.dispatch,
    incoming: incoming(),
    reads: { book: { kind: 'subject', id: book }, works: { kind: 'search', body: search } },
    session: { ring, scope },
  });
  const components = decodeSession(ring, scope, session!)!.sort((a, b) => a.partition - b.partition);
  expect(components).toEqual([
    { partition: 3, epoch: 1, position: 1n },
    { partition: 7, epoch: 1, position: 40n },
    { partition: 9, epoch: 2, position: 5n },
  ]);
  const quiet = await readPage({
    dispatch: fakeKernel().dispatch,
    incoming: incoming(),
    reads: { gone: { kind: 'subject', id: missing } },
    session: { ring, scope },
  });
  expect(quiet.session).toBeNull();
});

test('a page holds at most sixteen valid reads, runs at most four at a time and dispatches identical reads once', async () => {
  expect(MAX_PAGE_READS).toBe(16);
  const ids = Array.from({ length: 17 }, (_, i) => `018f0000-0000-7000-8000-${String(i).padStart(12, '0')}`);
  const reads = (count: number) =>
    Object.fromEntries(ids.slice(0, count).map((id, i) => [`r${i}`, { kind: 'subject' as const, id }]));

  const refused = fakeKernel();
  const tooMany = readPage({
    dispatch: refused.dispatch,
    incoming: incoming(),
    reads: reads(17),
    session: { ring, scope },
  });
  await expect(tooMany).rejects.toBeInstanceOf(PageReadError);
  await tooMany.catch((error: PageReadError) =>
    expect(error.errors).toEqual([{ pointer: '/reads', code: 'out_of_range' }]),
  );
  const malformed = readPage({
    dispatch: refused.dispatch,
    incoming: incoming(),
    reads: {
      'bad key': { kind: 'subject', id: book },
      upper: { kind: 'subject', id: book.toUpperCase() },
      more: { kind: 'search', body: { ...search, cursor: 'abc' } },
      odd: { kind: 'threads', id: book } as never,
    },
    session: { ring, scope },
  });
  await expect(malformed).rejects.toBeInstanceOf(PageReadError);
  await malformed.catch((error: PageReadError) =>
    expect(error.errors).toEqual([
      { pointer: '/reads/bad key', code: 'invalid_format' },
      { pointer: '/reads/more/body/cursor', code: 'unknown_field' },
      { pointer: '/reads/odd/kind', code: 'invalid_format' },
      { pointer: '/reads/upper/id', code: 'invalid_format' },
    ]),
  );
  expect(refused.seen).toEqual([]);

  const full = fakeKernel();
  const { results } = await readPage({
    dispatch: full.dispatch,
    incoming: incoming(),
    reads: reads(16),
    session: { ring, scope },
  });
  expect(Object.keys(results).length).toBe(16);
  expect(full.seen.length).toBe(16);
  expect(full.peak()).toBeLessThanOrEqual(4);

  const shared = fakeKernel();
  const twice = await readPage({
    dispatch: shared.dispatch,
    incoming: incoming(),
    reads: {
      a: { kind: 'subject', id: book },
      b: { kind: 'subject', id: book },
      c: { kind: 'search', body: { limit: 12, sort: 'name', filter: search.filter } },
      d: { kind: 'search', body: search },
    },
    session: { ring, scope },
  });
  expect(twice.results.a).toEqual(twice.results.b);
  expect(twice.results.c).toEqual(twice.results.d);
  expect(shared.seen.length).toBe(2);
});

test('closed descriptors and malformed owned JSON are refused before any dispatch or dedup', async () => {
  let calls = 0;
  const dispatch = async () => {
    calls++;
    throw new Error('invalid plans must not dispatch');
  };
  const closed = readPage({
    incoming: incoming(),
    session: { ring, scope },
    dispatch,
    reads: {
      clean: { kind: 'subject', id: book },
      subject: { kind: 'subject', id: book, 'extra/~': true } as never,
      search: { kind: 'search', body: search, 'extra/~': true } as never,
      'bad/~': { kind: 'search', body: { cursor: 'hidden', limit: 0 } },
    },
  });
  await expect(closed).rejects.toBeInstanceOf(PageReadError);
  await closed.catch((error: PageReadError) =>
    expect(error.errors).toEqual([
      { pointer: '/reads/bad~1~0', code: 'invalid_format' },
      { pointer: '/reads/bad~1~0/body/cursor', code: 'unknown_field' },
      { pointer: '/reads/bad~1~0/body/limit', code: 'out_of_range' },
      { pointer: '/reads/search/extra~1~0', code: 'unknown_field' },
      { pointer: '/reads/subject/extra~1~0', code: 'unknown_field' },
    ]),
  );
  let hooks = 0;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const badData = [
    { 'x/~': undefined },
    { 'x/~': NaN },
    { 'x/~': Infinity },
    { 'x/~': 1n },
    { 'x/~': () => true },
    { 'x/~': Symbol('value') },
    { 'x/~': new Date() },
    { 'x/~': cycle },
    { 'x/~': [, 1] },
    Object.create({ limit: 100 }),
    {
      toJSON() {
        hooks++;
        return { limit: 1 };
      },
    },
    Object.defineProperty({}, 'limit', {
      enumerable: true,
      get() {
        hooks++;
        return 1;
      },
    }),
  ];
  for (const body of badData) {
    await expect(
      readPage({
        incoming: incoming(),
        session: { ring, scope },
        dispatch,
        reads: { clean: { kind: 'subject', id: book }, bad: { kind: 'search', body } },
      }),
    ).rejects.toBeInstanceOf(PageReadError);
  }
  expect(hooks).toBe(0);
  expect(calls).toBe(0);
});

test('every limited descriptor validates its positive native range before any IO', async () => {
  const descriptors = [
    { kind: 'links', id: book, property: 'schema:author', limit: 25 },
    { kind: 'collections', id: book, limit: 7 },
    { kind: 'accountThreads', id: book, threadKind: 'review', limit: 21 },
    { kind: 'accountPosts', id: book, limit: 21 },
    { kind: 'accountCollections', id: book, limit: 25 },
    ...[0, -1, 1.5, 101, null, '20', false].map((limit) => ({ kind: 'search', body: { limit } })),
  ];
  let calls = 0;
  for (const descriptor of descriptors) {
    const operation = readPage({
      incoming: incoming(),
      session: { ring, scope },
      reads: { clean: { kind: 'subject', id: book }, bad: descriptor } as never,
      async dispatch() {
        calls++;
        throw new Error('invalid plan dispatched');
      },
    });
    await expect(operation).rejects.toBeInstanceOf(PageReadError);
    await operation.catch((error: PageReadError) =>
      expect(error.errors).toEqual([
        { pointer: descriptor.kind === 'search' ? '/reads/bad/body/limit' : '/reads/bad/limit', code: 'out_of_range' },
      ]),
    );
  }
  expect(calls).toBe(0);
});

test('a subject redirect cannot change operation, origin or canonical URL custody', async () => {
  const locations = [
    '/v1/subjects:search',
    `/v1/subjects/${survivor}/links`,
    '/v1/accounts',
    `/v1/subjects/${survivor}?context=${book}`,
    `/v1/subjects/${survivor}?`,
    `/v1/subjects/${survivor}#fragment`,
    `/v1/subjects/${survivor}#`,
    `http://foreign.test/v1/subjects/${survivor}`,
    `https://kernel.test/v1/subjects/${survivor}`,
    `http://user:password@kernel.test/v1/subjects/${survivor}`,
    `//kernel.test/v1/subjects/${survivor}`,
    `/v1/subjects/${survivor.toUpperCase()}`,
    '/v1/subjects/not-an-id',
    `/v1/subjects/${survivor}/`,
    `/v1/subjects/../subjects/${survivor}`,
    `/v1/subjects/%30${survivor.slice(1)}`,
    'http://[',
  ];
  for (const location of locations) {
    let calls = 0;
    const observed = encodeSession(ring, scope, [{ partition: 11, epoch: 1, position: 10n }]);
    const page = await readPage({
      incoming: incoming(),
      session: { ring, scope },
      reads: { old: { kind: 'subject', id: merged } },
      async dispatch() {
        calls++;
        return Response.json(
          { redirect: { from: merged, to: survivor } },
          {
            status: 308,
            headers: { location, [SESSION_HEADER]: observed },
          },
        );
      },
    });
    expect(calls, location).toBe(1);
    expect(page.results.old).toEqual({ status: 308, body: { redirect: { from: merged, to: survivor } } });
    expect(decodeSession(ring, scope, page.session!)!).toContainEqual({ partition: 11, epoch: 1, position: 10n });
  }
});

test('a second canonical redirect is returned without a third dispatch and preserves both observations', async () => {
  const seen: string[] = [];
  const page = await readPage({
    incoming: incoming(),
    session: { ring, scope },
    reads: { old: { kind: 'subject', id: merged } },
    async dispatch(request) {
      seen.push(request.url);
      expect(request.method).toBe('GET');
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('authorization')).toBe('Bearer reader');
      expect(request.headers.get(SESSION_HEADER)).toBe(callerToken);
      return Response.json(
        { redirect: { from: survivor, to: book } },
        {
          status: 308,
          headers: {
            location: seen.length === 1 ? `http://kernel.test/v1/subjects/${survivor}` : `/v1/subjects/${book}`,
            [SESSION_HEADER]: encodeSession(ring, scope, [{ partition: 11, epoch: 1, position: BigInt(seen.length) }]),
          },
        },
      );
    },
  });
  expect(seen).toEqual([`http://kernel.test/v1/subjects/${merged}`, `http://kernel.test/v1/subjects/${survivor}`]);
  expect(page.results.old!.status).toBe(308);
  expect(decodeSession(ring, scope, page.session!)!).toContainEqual({ partition: 11, epoch: 1, position: 2n });
});

test('malformed data reports its deterministic escaped pointer and never invokes serialization', async () => {
  const operation = readPage({
    incoming: incoming(),
    session: { ring, scope },
    reads: { bad: { kind: 'search', body: { 'field/~': undefined } } },
    async dispatch() {
      throw new Error('malformed data dispatched');
    },
  });
  await expect(operation).rejects.toBeInstanceOf(PageReadError);
  await operation.catch((error: PageReadError) =>
    expect(error.errors).toEqual([{ pointer: '/reads/bad/body/field~1~0', code: 'invalid_type' }]),
  );
});

test('non-subject operations never follow a redirect and dispatch failures drain admitted siblings', async () => {
  let calls = 0;
  const operation = await readPage({
    incoming: incoming(),
    session: { ring, scope },
    reads: { search: { kind: 'search', body: search } },
    async dispatch() {
      calls++;
      return Response.json({ redirect: true }, { status: 308, headers: { location: `/v1/subjects/${book}` } });
    },
  });
  expect(calls).toBe(1);
  expect(operation.results.search!.status).toBe(308);
  const failed = new Error('first read failed');
  const completed: string[] = [];
  const ids = Array.from({ length: 6 }, (_, index) => `018f0000-0000-7000-8000-${String(index).padStart(12, '0')}`);
  await expect(
    readPage({
      incoming: incoming(),
      session: { ring, scope },
      reads: Object.fromEntries(ids.map((id, index) => [`r${index}`, { kind: 'subject', id }])),
      async dispatch(request) {
        const id = new URL(request.url).pathname.split('/').at(-1)!;
        await Bun.sleep(id === ids[0] ? 10 : 1);
        completed.push(id);
        if (id === ids[0]) throw failed;
        if (id === ids[1]) throw new Error('later read failed');
        return Response.json(notFound, { status: 404 });
      },
    }),
  ).rejects.toBe(failed);
  expect(completed.sort()).toEqual(ids);
});
