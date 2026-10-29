import { afterAll, expect, test } from 'bun:test';
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedStatement,
  type IndexedSubject,
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
const target = id(9000, '00b0');
const author = 'schema:author';
const groups = ['order', 'derivation', 'world', 'membership', 'association', 'credit', 'appearance'];
const properties = groups.map((group) => (group === 'credit' ? author : `rezics:${group}`));
const descriptive = 'schema:genre';
const qualifier = 'rezics:role';
const books: FilterDocument = { type: { in: ['schema:Book'] } };
const leaf = (property = author, values = [target]): FilterDocument => ({ statement: { property, in: values } });
const release: FilterRelease = {
  types: Object.fromEntries(
    ['schema:Book', 'schema:Recipe'].map((type) => [type, { facets: [...properties, descriptive] }]),
  ),
  properties: {
    ...Object.fromEntries(
      properties.map((property, index) => [
        property,
        {
          datatype: 'wikibase-item',
          relation: { group: groups[index]! },
        },
      ]),
    ),
    [descriptive]: { datatype: 'wikibase-item', relation: { group: 'classification' }, qualifiers: [qualifier] },
    [qualifier]: { datatype: 'wikibase-item' },
  },
  filters: { 'books/live': { filter: { and: [books, leaf()] } } },
};
const relation = (property: string, value: string): IndexedStatement => ({ property, value, facet: { kind: 'item' } });
function entry(n: number, degree = 1, property = author, patch: Partial<IndexedSubject> = {}): IndexedSubject {
  return {
    id: id(n),
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: `Entry ${n}` }],
    aliases: [],
    descriptions: [],
    // The queried value deliberately stays inside the sampled prefix, even above the bound.
    statements: [
      relation(property, target),
      ...Array.from({ length: Math.min(degree, 128) - 1 }, (_, i) => relation(property, id(i + 10000, '00b0'))),
    ],
    relationFacetOverflow: degree > 128 ? [property] : [],
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

type Failure = 'missing' | 'throw' | 'short' | 'long' | 'nonboolean' | 'sparse' | 'null' | 'read' | 'deadline';
async function deployment(entries: IndexedSubject[]) {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const snapshots = createFakeSource();
  for (const subject of entries) snapshots.put(subject);
  const hidden = new Set<string>();
  const probes: { partition: number; points: readonly RelationFacetProbe[] }[] = [];
  const reads: string[][] = [];
  const calls: { after?: string[]; size: number }[] = [];
  const lineage: string[][] = [];
  let failure: Failure | undefined;
  const source: SubjectSource = {
    async read(partition, ids) {
      reads.push([...ids]);
      if (failure === 'read') throw new Error('anchor unavailable');
      return snapshots.read(partition, ids);
    },
    async count() {
      throw new Error('Search must not scan the source');
    },
    async matchRelationFacets(partition, points) {
      probes.push({ partition, points: [...points] });
      expect(points.length).toBeLessThanOrEqual(MAX_RELATION_FACET_PROBES);
      expect(points.every((point) => subjectPartition(point.subject) === partition)).toBe(true);
      expect(points.every((point) => Object.keys(point).sort().join() === 'property,subject,value')).toBe(true);
      if (failure === 'throw') throw new Error('proof unavailable');
      if (failure === 'deadline') throw new ProblemError('deadline_exceeded');
      if (failure) {
        const malformed: unknown =
          failure === 'short'
            ? []
            : failure === 'long'
              ? [...points.map(() => false), false]
              : failure === 'nonboolean'
                ? points.map(() => 0)
                : failure === 'sparse'
                  ? Array(points.length)
                  : null;
        return malformed as boolean[];
      }
      // This is authoritative witness/fence state, independent of the stale bounded snapshot.
      return points.map(
        (point) =>
          !hidden.has(point.subject) &&
          entries.some(
            (subject) =>
              subject.id === point.subject &&
              subject.statements.some(
                (statement) => statement.property === point.property && statement.value === point.value,
              ),
          ),
      );
    },
  };
  const client: OpenSearch = {
    bulk: (...args) => engine.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const searching = args[1].endsWith('/_search/template');
      if (searching) calls.push((args[2] as { params: { after?: string[]; size: number } }).params);
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
  for (const partition of new Set(entries.map((subject) => subjectPartition(subject.id)))) {
    const ids = entries.filter((subject) => subjectPartition(subject.id) === partition).map((subject) => subject.id);
    const snapshot = await snapshots.read(partition, ids);
    expect(
      (
        await engine.bulk<{ errors: boolean }>(bulkLines(index, documentActions(snapshot, ids)), {
          query: { refresh: 'wait_for' },
        })
      ).errors,
    ).toBe(false);
  }
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
  async function request(body: unknown, operation = 'search') {
    reads.length = probes.length = calls.length = lineage.length = 0;
    return kernel.handle(
      new Request(`http://kernel.test/v1/subjects:${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }
  async function search(filter: FilterDocument | undefined, options: Record<string, unknown> = {}) {
    const response = await request({ ...(filter ? { filter } : {}), sort: 'id', ...options });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.every((call) => call.size <= 200)).toBe(true);
    return body;
  }
  return {
    hidden,
    snapshots,
    source,
    reads,
    probes,
    calls,
    lineage,
    search,
    request,
    fail(mode: Failure) {
      failure = mode;
      if (mode === 'missing') delete source.matchRelationFacets;
    },
  };
}
const ids = (page: { subjects: { id: string }[] }) => page.subjects.map((subject) => subject.id);

test('positive relation matches are checked live even within the sampled prefix', async () => {
  for (const degree of [1, 128, 129]) {
    const subjects = [entry(1, degree), entry(2, degree)];
    const env = await deployment(subjects);
    const before = await env.search(leaf());
    expect(ids(before)).toEqual(subjects.map((subject) => subject.id));
    expect(before).not.toHaveProperty('total');
    env.hidden.add(id(1));
    const after = await env.search({ saved: 'books/live' });
    expect(ids(after)).toEqual([id(2)]);
    expect(after).not.toHaveProperty('total');
    expect(env.probes.flatMap((call) => call.points)).toEqual(
      subjects.map((subject) => ({ subject: subject.id, property: author, value: target })),
    );
    expect(env.lineage.every((names) => names.includes('f1'))).toBe(true);
    expect((await env.snapshots.read(10, [id(1)])).subjects[0]!.statements[0]!.value).toBe(target);
  }
});

test('live relation rejection refills and continues without revealing stale witnesses', async () => {
  const subjects = Array.from({ length: 17 }, (_, n) => entry(n + 1, 128));
  const env = await deployment(subjects);
  subjects.slice(0, 12).forEach((subject) => env.hidden.add(subject.id));
  const found: string[] = [];
  const examined: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await env.search(leaf(), { limit: 1, ...(cursor ? { cursor } : {}) });
    examined.push(...env.probes.flatMap((call) => call.points.map((point) => point.subject)));
    if (pages === 0) {
      expect(page.subjects).toEqual([]);
      expect(page).not.toHaveProperty('total');
      expect(env.calls).toHaveLength(3);
      expect(page.next).toEqual(expect.any(String));
    }
    expect(page).not.toHaveProperty('total');
    found.push(...ids(page));
    cursor = page.next ?? undefined;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(found).toEqual(subjects.slice(12).map((subject) => subject.id));
  const rejected = examined.filter((subject) => env.hidden.has(subject));
  expect(rejected).toEqual(subjects.slice(0, 12).map((subject) => subject.id));
});

test('continuation consumes trailing rejected candidates after filling the page', async () => {
  const env = await deployment([entry(1), entry(2), entry(3), entry(4)]);
  env.hidden.add(id(2));
  env.hidden.add(id(3));
  const first = await env.search(leaf(), { limit: 1 });
  expect(ids(first)).toEqual([id(1)]);
  expect(first).not.toHaveProperty('total');
  expect(first.next).toEqual(expect.any(String));
  const next = await env.search(leaf(), { limit: 1, cursor: first.next });
  expect(ids(next)).toEqual([id(4)]);
  expect(next).not.toHaveProperty('total');
  expect(env.calls[0]!.after).toEqual([id(3)]);
  expect(env.probes.flatMap((call) => call.points.map((point) => point.subject))).toEqual([id(4)]);
});

test('release metadata selects every relation group while descriptive qualifiers retain snapshot semantics', async () => {
  const env = await deployment([
    entry(1, 1, author, {
      statements: [
        ...properties.map((property) => relation(property, target)),
        { ...relation(descriptive, target), qualifiers: [{ property: qualifier, value: target }] },
      ],
    }),
  ]);
  env.hidden.add(id(1));
  for (const property of properties) {
    expect(ids(await env.search(leaf(property)))).toEqual([]);
    expect(env.probes.flatMap((call) => call.points)).toEqual([{ subject: id(1), property, value: target }]);
  }
  const descriptiveFilter: FilterDocument = {
    statement: { property: descriptive, in: [target], qualifiers: [{ property: qualifier, in: [target] }] },
  };
  expect(ids(await env.search(descriptiveFilter))).toEqual([id(1)]);
  expect(env.probes).toEqual([]);
  for (const filter of [undefined, books]) {
    expect(ids(await env.search(filter))).toEqual([id(1)]);
    expect(env.probes).toEqual([]);
    expect(env.reads).toEqual([[id(1)]]);
  }
  env.snapshots.put(entry(1, 1, author, { visibility: 'hidden' }));
  expect(ids(await env.search(books))).toEqual([]);
});

test('AND OR nested NOT and shared positive and negative leaves use complete live Boolean evaluation', async () => {
  // Overflow supplies negative candidates even when their indexed samples still contain the hidden witness.
  for (const degree of [1, 129]) {
    const subjects = [
      entry(1, degree),
      entry(2, degree),
      entry(3, degree, author, { type: 'schema:Recipe' }),
      entry(4, degree, author, { type: 'schema:Recipe' }),
    ];
    const env = await deployment(subjects);
    env.hidden.add(id(2));
    env.hidden.add(id(4));
    const cases: [FilterDocument, number[], string?][] = [
      [{ and: [books, leaf()] }, [1]],
      [{ or: [books, leaf()] }, [1, 2, 3]],
      [{ not: { and: [{ not: leaf() }] } }, [1, 3], 'entry'],
      [{ not: { and: [books, leaf()] } }, degree > 128 ? [2, 3, 4] : [3, 4], 'entry'],
      // Visit the negative occurrence first; a later positive occurrence must upgrade its policy.
      [{ or: [{ not: leaf() }, leaf()] }, [1, 2, 3, 4], 'entry'],
    ];
    for (const [filter, kept, text] of cases) {
      const page = await env.search(filter, { ...(text ? { text } : {}) });
      expect(ids(page)).toEqual(kept.map((n) => id(n)));
      const points = env.probes.flatMap((call) => call.points);
      if (degree === 1 && 'not' in filter && 'and' in filter.not && filter.not.and.length === 2)
        expect(points).toEqual([]);
      else {
        expect(points).toHaveLength('and' in filter ? 2 : 4);
        expect(new Set(points.map((point) => point.subject)).size).toBe(points.length);
      }
    }
  }
});

test('a shared positive and negative leaf can reject a stale negative candidate with a true live proof', async () => {
  const subjects = [entry(1, 1, author, { type: 'schema:Recipe', statements: [] })];
  const env = await deployment(subjects);
  // The index and bounded read still lack the relation; only authoritative proof state advances.
  subjects[0] = entry(1, 1, author, { type: 'schema:Recipe' });
  const page = await env.search({
    or: [{ and: [books, leaf()] }, { and: [{ type: { in: ['schema:Recipe'] } }, { not: leaf() }] }],
  });
  expect(ids(page)).toEqual([]);
  expect(page).not.toHaveProperty('total');
  expect(env.probes.flatMap((call) => call.points)).toEqual([{ subject: id(1), property: author, value: target }]);
});

test('negative overflow rechecks and descriptive qualifiers keep their contracts', async () => {
  const env = await deployment([entry(1, 129), entry(2, 129)]);
  env.hidden.add(id(1));
  expect(ids(await env.search({ and: [books, { not: leaf() }] }))).toEqual([id(1)]);
  expect(env.probes.flatMap((call) => call.points)).toHaveLength(2);
  const bounded = await deployment([entry(1)]);
  bounded.hidden.add(id(1));
  // A negative nonoverflow query may omit the subject until its bounded evidence is rebuilt.
  expect(ids(await bounded.search({ and: [books, { not: leaf() }] }))).toEqual([]);
  expect(bounded.probes).toEqual([]);
});

test('unavailable or malformed live proofs fail the entire HTTP response including negation', async () => {
  for (const mode of [
    'missing',
    'throw',
    'short',
    'long',
    'nonboolean',
    'sparse',
    'null',
    'read',
    'deadline',
  ] as const) {
    const env = await deployment([entry(1), entry(2, 129)]);
    env.fail(mode);
    for (const filter of [leaf(), { and: [books, { not: leaf() }] }]) {
      const response = await env.request({ filter });
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({
        code: mode === 'deadline' ? 'deadline_exceeded' : 'semantic_not_ready',
        retryable: true,
      });
      expect(body.subjects).toBeUndefined();
      if (mode !== 'deadline') expect(response.headers.get('retry-after')).toBe('1');
    }
  }
});

test('fixed page and filter have constant read and point work at degrees 128 512 and 2048', async () => {
  const operations = [];
  for (const degree of [128, 512, 2048]) {
    const env = await deployment([entry(1, degree), entry(2, degree), entry(3, degree)]);
    const page = await env.search({ and: [leaf(author, [target, target]), leaf()] }, { limit: 2 });
    expect(ids(page)).toEqual([id(1), id(2)]);
    operations.push({
      rounds: env.calls.length,
      reads: env.reads.length,
      subjects: env.reads.flat().length,
      batches: env.probes.length,
      probes: env.probes.flatMap((call) => call.points).length,
    });
    const response = await env.request({ filter: leaf(), facets: [{ property: 'type' }] }, 'facets');
    expect(response.status).toBe(200);
    expect(env.probes).toEqual([]);
  }
  expect(operations).toEqual(
    Array.from({ length: 3 }, () => ({ rounds: 1, reads: 1, subjects: 3, batches: 1, probes: 3 })),
  );
});
