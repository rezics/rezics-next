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
