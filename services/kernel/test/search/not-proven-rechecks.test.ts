import { afterAll, expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetMatch,
  type RelationFacetProbe,
  type SubjectSource,
} from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl) throw new Error('DATABASE_URL and OPENSEARCH_URL are required');
const pool = createPool(databaseUrl);
const engine = createOpenSearch(searchUrl);
const prefixes: string[] = [];
const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = 'schema:author';
const targets = [id(9000, '00b0'), id(9001, '00b0'), id(9002, '00b0')];
const leaf = (values = [targets[0]!]): FilterDocument => ({ statement: { property: author, in: values } });
const books: FilterDocument = { type: { in: ['schema:Book'] } };
const release = {
  types: { 'schema:Book': { facets: [author] }, 'schema:Recipe': { facets: [author] } },
  properties: { [author]: { datatype: 'wikibase-item', relation: { group: 'credit' } } },
};
function entry(n: number, degree = 129, patch: Partial<IndexedSubject> = {}): IndexedSubject {
  return {
    id: id(n),
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: `Entry ${n}` }],
    aliases: [],
    descriptions: [],
    statements: Array.from({ length: degree }, (_, i) => ({
      property: author,
      value: targets[i] ?? id(i + 10000, '00b0'),
      facet: { kind: 'item' },
    })),
    relationFacetOverflow: degree > 128 ? [author] : [],
    ...patch,
  };
}

afterAll(async () => {
  for (const prefix of prefixes) {
    await engine.request('DELETE', `/${subjectIndexName(prefix, 1)}`).catch(() => undefined);
    for (const name of [SEARCH_TEMPLATE, FACET_TEMPLATE, SUGGEST_TEMPLATE])
      await engine.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
  await pool.end();
});

async function deployment(entries: IndexedSubject[]) {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const snapshots = createFakeSource();
  for (const subject of entries) snapshots.put(subject);
  // Deliberately unrelated to every indexed candidate; source extras must never be disclosed.
  const unrelated = entry(8000);
  const probes: RelationFacetProbe[][] = [];
  const reads: string[][] = [];
  const calls: { size: number; after?: string[] }[] = [];
  const lineage: string[][] = [];
  let answer: (point: RelationFacetProbe) => RelationFacetMatch = () => 'not_proven';
  let malformed: unknown;
  let failure = false;
  const source: SubjectSource = {
    async read(partition, ids) {
      reads.push([...ids]);
      const snapshot = await snapshots.read(partition, ids);
      return {
        ...snapshot,
        subjects: [...snapshot.subjects, unrelated].map((subject) => ({
          ...subject,
          statements: subject.statements.slice(0, 128),
        })),
      };
    },
    async count() {
      throw new Error('Search must not scan the source');
    },
    async matchRelationFacets(partition, points) {
      expect(points.length).toBeLessThanOrEqual(MAX_RELATION_FACET_PROBES);
      expect(points.every((point) => subjectPartition(point.subject) === partition)).toBe(true);
      expect(points.every((point) => Object.keys(point).sort().join() === 'property,subject,value')).toBe(true);
      probes.push([...points]);
      if (failure) throw new Error('Witness helper unavailable');
      if (malformed !== undefined) return malformed as RelationFacetMatch[];
      // Controlled layer results, independent of the stale engine and anchor samples.
      return points.map(answer);
    },
  };
  const client: OpenSearch = {
    bulk: (...args) => engine.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const searching = args[1].endsWith('/_search/template');
      if (searching) calls.push((args[2] as { params: { size: number; after?: string[] } }).params);
      const response = await engine.request<T>(...args);
      if (searching)
        lineage.push(
          ...(response.body as { hits: { hits: { matched_queries?: string[] }[] } }).hits.hits.map(
            (hit) => hit.matched_queries ?? [],
          ),
        );
      return response;
    },
  };
  const index = subjectIndexName(prefix, 1);
  await createSubjectIndex(engine, prefix, 1);
  const partition = subjectPartition(entries[0]!.id);
  const ids = entries.map((subject) => subject.id);
  const snapshot = await source.read(partition, ids);
  expect(
    (
      await engine.bulk<{ errors: boolean }>(bulkLines(index, documentActions(snapshot, ids)), {
        query: { refresh: 'wait_for' },
      })
    ).errors,
  ).toBe(false);
  await engine.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  const service = createSearchService({
    pool,
    client,
    prefix,
    source,
    cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) },
    release: async () => release,
  });
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(13),
    search: service,
    access: {
      async authenticate() {
        throw new Error('No credentials');
      },
      async authorize(_client, _actor, action) {
        return action === 'subject:read';
      },
    },
  });
  async function request(filter: FilterDocument, options: Record<string, unknown> = {}) {
    reads.length = probes.length = calls.length = lineage.length = 0;
    return kernel.handle(
      new Request('http://kernel.test/v1/subjects:search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter, sort: 'id', ...options }),
      }),
    );
  }
  async function search(filter: FilterDocument, options: Record<string, unknown> = {}) {
    const response = await request(filter, options);
    const body = await response.json();
    expect(response.status, JSON.stringify({ filter, body })).toBe(200);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.every((call) => call.size <= 200)).toBe(true);
    expect(body.subjects.map((subject: { id: string }) => subject.id)).not.toContain(unrelated.id);
    return body;
  }
  return {
    snapshots,
    probes,
    reads,
    calls,
    lineage,
    search,
    request,
    answer(value: typeof answer) {
      answer = value;
    },
    malformed(value: unknown) {
      malformed = value;
    },
    fail() {
      failure = true;
    },
  };
}
const ids = (page: { subjects: { id: string }[] }) => page.subjects.map((subject) => subject.id);

test('not-proven relation points are dropped and refilled without becoming negative matches', async () => {
  // No overflow marker: positive live uncertainty still cannot add public aggregate metadata.
  const entries = Array.from({ length: 9 }, (_, i) => entry(i + 1, 128));
  const env = await deployment(entries);
  env.answer((point) => (point.subject === id(4) || point.subject === id(9) ? true : 'not_proven'));
  for (const [index, patch] of [
    [4, { visibility: 'hidden' }],
    [5, { redirect: id(4) }],
    [6, { securityRevision: 2 }],
    [7, { visibility: 'taken_down' }],
  ] as const)
    env.snapshots.put({ ...entries[index]!, ...patch });
  const page = await env.search(leaf(), { limit: 2 });
  expect(ids(page)).toEqual([id(4), id(9)]);
  expect(page).not.toHaveProperty('total');
  expect(page.next).toBeNull();
  expect(env.calls).toHaveLength(3);
  expect(env.calls.slice(1).every((call) => call.after !== undefined)).toBe(true);
  expect(env.probes.flat().map((point) => point.subject)).toEqual([id(1), id(2), id(3), id(4), id(9)]);
  expect(env.lineage.some((names) => names.length > 0)).toBe(true);

  const negative = await deployment([entry(1), entry(2), entry(3)]);
  negative.answer((point) => (point.subject === id(2) ? false : point.subject === id(3) ? true : 'not_proven'));
  const excluded = await negative.search({ and: [books, { not: leaf() }] });
  expect(ids(excluded)).toEqual([id(2)]);
  expect(excluded).not.toHaveProperty('total');
});

test('not-proven points preserve three-valued filter truth and keyset continuation', async () => {
  const env = await deployment([entry(1), entry(2), entry(3)]);
  const a = leaf();
  const b = leaf([targets[1]!]);
  const c = leaf([targets[2]!]);
  env.answer((point) => (point.value === targets[1] ? true : point.value === targets[2] ? false : 'not_proven'));
  const cases: [FilterDocument, boolean][] = [
    [a, false],
    [leaf([targets[0]!, targets[1]!]), true],
    [leaf([targets[0]!, targets[2]!]), false],
    [leaf([targets[2]!]), false],
    [{ not: leaf([targets[0]!, targets[2]!]) }, false],
    [{ not: c }, true],
    [{ not: a }, false],
    // Admission separates nested NOT operators with a Boolean group.
    [{ not: { and: [{ not: a }] } }, false],
    [{ and: [a, b] }, false],
    [{ and: [a, c] }, false],
    [{ or: [a, b] }, true],
    [{ or: [a, c] }, false],
    [{ not: { and: [a, c] } }, true],
    [{ not: { or: [a, b] } }, false],
    [{ or: [{ not: a }, a] }, false],
    [{ and: [{ not: a }, a] }, false],
    [{ or: [{ and: [a, b] }, { not: c }] }, true],
  ];
  for (const [expression, proven] of cases) {
    const page = await env.search({ and: [books, expression] });
    expect(ids(page), JSON.stringify(expression)).toEqual(proven ? [id(1), id(2), id(3)] : []);
    expect(page).not.toHaveProperty('total');
    const points = env.probes.flat();
    expect(new Set(points.map((point) => JSON.stringify(point))).size).toBe(points.length);
  }

  const combinations: [RelationFacetMatch, RelationFacetMatch, boolean][] = [
    [true, true, true],
    [true, false, true],
    [true, 'not_proven', true],
    [false, false, false],
    [false, 'not_proven', false],
    ['not_proven', 'not_proven', false],
  ];
  for (const [first, second, proven] of combinations) {
    env.answer((point) => (point.value === targets[0] ? first : second));
    const page = await env.search(leaf(targets.slice(0, 2)));
    expect(ids(page)).toEqual(proven ? [id(1), id(2), id(3)] : []);
  }

  const entries = Array.from({ length: 17 }, (_, i) => entry(i + 1, 128));
  const pages = await deployment(entries);
  pages.answer((point) => (Number(point.subject.slice(-8)) > 12 ? true : 'not_proven'));
  let cursor: string | undefined;
  const found: string[] = [];
  const uncertain: string[] = [];
  let count = 0;
  do {
    const page = await pages.search(a, { limit: 1, ...(cursor ? { cursor } : {}) });
    if (count === 0) {
      expect(ids(page)).toEqual([]);
      expect(pages.calls).toHaveLength(3);
      expect(page.next).toEqual(expect.any(String));
    }
    uncertain.push(
      ...pages.probes
        .flat()
        .filter((point) => Number(point.subject.slice(-8)) <= 12)
        .map((point) => point.subject),
    );
    found.push(...ids(page));
    expect(page).not.toHaveProperty('total');
    cursor = page.next ?? undefined;
    expect(++count).toBeLessThan(10);
  } while (cursor);
  expect(found).toEqual(entries.slice(12).map((subject) => subject.id));
  expect(uncertain).toEqual(entries.slice(0, 12).map((subject) => subject.id));

  const first = await pages.search(a, { limit: 1 });
  const tampered = `${first.next.slice(0, -8)}AAAAAAAA`;
  expect((await pages.request(a, { limit: 1, cursor: tampered })).status).toBe(400);

  pages.answer(() => 'not_proven');
  const allUnknown = await pages.search(a, { limit: 100 });
  expect(ids(allUnknown)).toEqual([]);
  expect(allUnknown.next).toBeNull();
  expect(allUnknown).not.toHaveProperty('total');
});

test('a repaired witness restores the result without an engine contract change', async () => {
  const env = await deployment([entry(1, 128)]);
  const before = await env.search(leaf());
  expect(ids(before)).toEqual([]);
  expect(before.next).toBeNull();
  const beforeCalls = structuredClone(env.calls);
  env.answer(() => true);
  expect(ids(await env.search(leaf()))).toEqual([id(1)]);
  expect(env.calls).toEqual(beforeCalls);
  env.fail();
  const response = await env.request(leaf());
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('1');
  expect(await response.json()).toMatchObject({ code: 'semantic_not_ready', retryable: true });
});

test('only aligned true false and not_proven point results are accepted', async () => {
  const env = await deployment([entry(1), entry(2)]);
  for (const malformed of [
    [],
    [true],
    [true, false, true],
    Array(2),
    [true, undefined],
    ['unknown', false],
    ['false', true],
    [null, true],
    [1, true],
    null,
  ]) {
    env.malformed(malformed);
    const response = await env.request({ or: [books, leaf()] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'semantic_not_ready', retryable: true });
  }
});

test('not-proven search work stays constant at stored degrees 128 512 and 2048', async () => {
  const operations = [];
  for (const degree of [128, 512, 2048]) {
    const env = await deployment([entry(1, degree), entry(2, degree), entry(3, degree)]);
    expect((await env.snapshots.read(subjectPartition(id(1)), [id(1)])).subjects[0]!.statements).toHaveLength(degree);
    env.answer((point) => (point.subject === id(2) ? true : 'not_proven'));
    const page = await env.search({ and: [leaf([targets[0]!, targets[0]!]), leaf()] }, { limit: 2 });
    expect(ids(page)).toEqual([id(2)]);
    expect(page).not.toHaveProperty('total');
    operations.push({
      requests: env.calls.length,
      reads: env.reads.length,
      subjects: env.reads.flat().length,
      batches: env.probes.length,
      points: env.probes.flat().length,
    });
  }
  expect(operations).toEqual(Array(3).fill({ requests: 1, reads: 1, subjects: 3, batches: 1, points: 3 }));
});

test('uncertain point batches retain the existing 256 bound and deduplicate shared leaves', async () => {
  const env = await deployment(Array.from({ length: 90 }, (_, n) => entry(n + 1)));
  const repeated = leaf([...targets, targets[0]!]);
  const page = await env.search({ or: [{ not: repeated }, repeated] }, { text: 'entry', limit: 100 });
  expect(ids(page)).toEqual([]);
  expect(page.next).toBeNull();
  expect(env.calls).toHaveLength(1);
  expect(env.probes.map((batch) => batch.length)).toEqual([256, 14]);
  const points = env.probes.flat().map((point) => JSON.stringify(point));
  expect(new Set(points).size).toBe(270);
});
