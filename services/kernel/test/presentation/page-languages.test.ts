import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { createFakeSource } from '../search/support/fake-source.ts';
import { PageReadError, readPage, type PageRead } from '../../src/presentation/reads.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl) throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check services');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const client = createOpenSearch(searchUrl);
const prefix = `test-${randomUUID().slice(0, 8)}-`;
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const realAccess = await createRealAccess(admin, accounts, ['subject:create']);
const source = createFakeSource();
const book: IndexedSubject = {
  id: '018f0000-0000-7000-8000-00a000000001',
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [
    { language: 'ja', value: 'こころ' },
    { language: 'en', value: 'Kokoro' },
  ],
  aliases: [],
  descriptions: [],
  statements: [{ property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } }],
};
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) };
const search = createSearchService({ pool, client, prefix, source, cursors });
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: page(node('Text', 'generic', { text: 'Generic' })) } },
  bases: [],
  types: [],
  routes: [
    {
      route: '/',
      document: page(
        node('TypeList', 'books', {
          title: { en: 'Books' },
          types: ['schema:Book'],
          sort: 'name',
          limit: 12,
        }),
      ),
    },
  ],
};
const kernel = createKernel({
  pool,
  requestDeadlineMs: 30_000,
  routeKey: new Uint8Array(32).fill(7),
  access: realAccess.access,
  writeRate: realAccess.writeRate,
  tokens,
  search,
});

afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
  await admin.end();
});

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await bootstrapProfile(pool, profile);

  const index = subjectIndexName(prefix, 1);
  await createSubjectIndex(client, prefix, 1);
  source.put(book);
  const snapshot = await source.read(subjectPartition(book.id), [book.id]);
  await client.bulk(bulkLines(index, documentActions(snapshot, [book.id])), { query: { refresh: 'wait_for' } });
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});

async function call(path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const pageRead = (languages?: unknown) =>
  call('/v1/pages:read', { target: { route: '/' }, ...(languages === undefined ? {} : { languages }) });
const searchBody = {
  filter: { type: { in: ['schema:Book'] } },
  sort: 'name',
  limit: 12,
};
const stableSearchResult = (body: Record<string, any>) => {
  const { as_of: _asOf, ...result } = body;
  return result;
};

test("a page read passes the reader's language chain to its search reads", async () => {
  for (const languages of [['zh-Hans', 'zh', 'zh-Hant'], ['en']]) {
    const page = await pageRead(languages);
    expect(page.response.status).toBe(200);
    const searchRead = page.body.reads.r0;
    expect(searchRead.status).toBe(200);
    expect(Object.keys(searchRead.body.subjects[0].labels)).toHaveLength(1);
    expect(searchRead.body.subjects[0].labels).toEqual(languages[0] === 'en' ? { en: 'Kokoro' } : { ja: 'こころ' });

    const standalone = await call('/v1/subjects:search', { ...searchBody, languages });
    expect(standalone.response.status).toBe(200);
    expect(stableSearchResult(searchRead.body)).toEqual(stableSearchResult(standalone.body));
  }
});

test('a page read without languages answers its search reads with every language', async () => {
  const page = await pageRead();
  expect(page.response.status).toBe(200);
  expect(page.body.reads.r0.body.subjects[0].labels).toEqual({ en: 'Kokoro', ja: 'こころ' });
});

test('a page read refuses an invalid language chain at /languages', async () => {
  const invalid = [
    { languages: [], error: { pointer: '/languages', code: 'out_of_range' } },
    {
      languages: ['en', 'ja', 'fr', 'de', 'it', 'es', 'pt', 'zh', 'ko'],
      error: { pointer: '/languages', code: 'out_of_range' },
    },
    { languages: ['en', 'en'], error: { pointer: '/languages/1', code: 'invalid_format' } },
    { languages: ['x'], error: { pointer: '/languages/0', code: 'invalid_format' } },
  ];
  for (const { languages, error } of invalid) {
    const answer = await pageRead(languages);
    expect(answer.response.status).toBe(400);
    expect(answer.body.code).toBe('invalid_request');
    expect(answer.body.errors).toEqual([error]);
  }
});

function nativePlan(reads: Record<string, PageRead>, languages?: readonly string[]) {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const operation = readPage({
    incoming: new Request('http://kernel.test/v1/pages:read'),
    reads,
    session: { ring: tokens, scope: 'anonymous' },
    ...(languages === undefined ? {} : { languages }),
    async dispatch(request) {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        return await kernel.handle(request);
      } finally {
        active--;
      }
    },
  });
  return { operation, calls: () => calls, peak: () => peak };
}
const nativeSearch = (limit?: number): PageRead => ({
  kind: 'search',
  body: { filter: searchBody.filter, sort: 'name', ...(limit === undefined ? {} : { limit }) },
});

test('actual native searches admit 127 and 128 slots and refuse 129 before dispatch', async () => {
  for (const slots of [127, 128, 129]) {
    const plan = nativePlan({ first: nativeSearch(100), second: nativeSearch(slots - 100) });
    if (slots > 128) {
      await expect(plan.operation).rejects.toBeInstanceOf(PageReadError);
      await plan.operation.catch((error: PageReadError) =>
        expect(error.errors).toEqual([{ pointer: '/reads', code: 'out_of_range' }]),
      );
      expect(plan.calls()).toBe(0);
    } else {
      const { results } = await plan.operation;
      expect(plan.calls()).toBe(2);
      for (const result of Object.values(results)) {
        expect(result.status).toBe(200);
        expect((result.body as { subjects: { id: string }[] }).subjects.map(({ id }) => id)).toEqual([book.id]);
      }
    }
  }
});

test('native default search slots and aliases use the effective positive limit', async () => {
  for (const extra of [8, 9]) {
    const plan = nativePlan({
      hundred: nativeSearch(100),
      default: nativeSearch(),
      explicit: nativeSearch(20),
      extra: nativeSearch(extra),
    });
    if (extra === 9) {
      await expect(plan.operation).rejects.toBeInstanceOf(PageReadError);
      expect(plan.calls()).toBe(0);
    } else {
      const { results } = await plan.operation;
      expect(plan.calls()).toBe(3);
      expect(results.default!.status).toBe(200);
      expect(results.default).toBe(results.explicit);
    }
  }
  for (const limit of [1, 20, 64, 100]) {
    const plan = nativePlan({ search: nativeSearch(limit) });
    const { results } = await plan.operation;
    const standalone = await call('/v1/subjects:search', { ...searchBody, limit });
    expect(results.search!.status).toBe(200);
    expect(stableSearchResult(results.search!.body as Record<string, any>)).toEqual(
      stableSearchResult(standalone.body),
    );
  }
});

test('sixteen native read descriptors retain the concurrency ceiling and share duplicate alias work', async () => {
  const distinct = nativePlan(
    Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `r${index}`,
        { kind: 'search', body: { ...searchBody, limit: 1, text: `missing${index}` } } as PageRead,
      ]),
    ),
  );
  const result = await distinct.operation;
  expect(Object.keys(result.results)).toHaveLength(16);
  expect(Object.values(result.results).map(({ status }) => status)).toEqual(Array(16).fill(200));
  expect(distinct.calls()).toBe(16);
  expect(distinct.peak()).toBeLessThanOrEqual(4);
  const aliases = (length: number) =>
    Object.fromEntries(Array.from({ length }, (_, index) => [`r${index}`, nativeSearch(100)]));
  const shared = nativePlan(aliases(16));
  const { results } = await shared.operation;
  expect(shared.calls()).toBe(1);
  expect(Object.keys(results)).toHaveLength(16);
  expect(results.r0!.status).toBe(200);
  for (const result of Object.values(results)) expect(result).toBe(results.r0!);
  const overflow = nativePlan(aliases(17));
  await expect(overflow.operation).rejects.toBeInstanceOf(PageReadError);
  expect(overflow.calls()).toBe(0);
});

test('page language binding precedes canonical dedup and retains every native alias result', async () => {
  const reads: Record<string, PageRead> = {
    japanese: { kind: 'search', body: { ...searchBody, limit: 100, languages: ['ja'] } },
    english: { kind: 'search', body: { ...searchBody, limit: 100, languages: ['en'] } },
    all: { kind: 'search', body: { ...searchBody, limit: 100 } },
  };
  const bound = nativePlan(reads, ['en']);
  const { results } = await bound.operation;
  expect(bound.calls()).toBe(1);
  expect(results.english!.status).toBe(200);
  expect((results.english!.body as any).subjects[0].labels).toEqual({ en: 'Kokoro' });
  expect(results.japanese).toBe(results.english);
  expect(results.all).toBe(results.english);
  expect((reads.japanese as { body: any }).body.languages).toEqual(['ja']);

  const unbound = nativePlan({
    japanese: { kind: 'search', body: { ...searchBody, languages: ['ja'] } },
    english: { kind: 'search', body: { ...searchBody, languages: ['en'] } },
  });
  const separate = await unbound.operation;
  expect(unbound.calls()).toBe(2);
  expect((separate.results.japanese!.body as any).subjects[0].labels).toEqual({ ja: 'こころ' });
  expect((separate.results.english!.body as any).subjects[0].labels).toEqual({ en: 'Kokoro' });
});

test('native per-read Search grammar errors remain isolated from admitted siblings', async () => {
  const plan = nativePlan({
    valid: nativeSearch(12),
    invalid: { kind: 'search', body: { ...searchBody, sort: 'not-a-sort' } },
  });
  const { results } = await plan.operation;
  expect(plan.calls()).toBe(2);
  expect(results.valid!.status).toBe(200);
  expect((results.valid!.body as any).subjects[0].id).toBe(book.id);
  expect(results.invalid!.status).toBe(400);
  expect((results.invalid!.body as any).code).toBe('invalid_request');
});

test('admission takes custody of native inputs and page languages before asynchronous dispatch', async () => {
  const bodies = Array.from({ length: 6 }, (_, index) => ({ ...searchBody, limit: index + 1 }));
  const languages = ['en'];
  let calls = 0;
  const result = await readPage({
    incoming: new Request('http://kernel.test/v1/pages:read'),
    reads: Object.fromEntries(bodies.map((body, index) => [`r${index}`, { kind: 'search', body }])),
    session: { ring: tokens, scope: 'anonymous' },
    languages,
    async dispatch(request) {
      if (calls++ === 0) {
        for (const body of bodies) body.limit = 100;
        languages[0] = 'ja';
      }
      const posted = (await request.clone().json()) as { limit: number; languages: string[] };
      expect(posted.limit).toBeLessThanOrEqual(6);
      expect(posted.languages).toEqual(['en']);
      return kernel.handle(request);
    },
  });
  expect(calls).toBe(6);
  for (const read of Object.values(result.results)) {
    expect(read.status).toBe(200);
    expect((read.body as any).subjects[0].labels).toEqual({ en: 'Kokoro' });
  }
});
