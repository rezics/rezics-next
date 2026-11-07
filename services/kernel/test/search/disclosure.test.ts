import { searchOperationProblem } from '../../src/search/http/operation-problems.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import type { Access } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId } from '../../src/route/route.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { discloseFacetValues } from '../../src/search/facets.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { SubjectSnapshot } from '../../src/search/source.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { checkHits, type FactClause, type Hit } from '../../src/search/disclosure/check.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

// Route 0x00a0 sits in partition 10; route 0x0123 in partition 18.
const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = id(90, '0123');
const other = id(91, '0123');
const book = (n: number, route = '00a0'): IndexedSubject => ({
  id: id(n, route),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [{ property: 'schema:author', value: author }],
});
const hit = (subject: IndexedSubject, matched: string[] = []): Hit => ({
  id: subject.id,
  partition: subjectPartition(subject.id),
  securityRevision: subject.securityRevision,
  matched,
});
const none = new Map<string, FactClause>();

function recording(source: SubjectSource) {
  const reads: { partition: number; ids: string[] }[] = [];
  const wrapped: SubjectSource = {
    read: (partition, ids) => {
      reads.push({ partition, ids: [...ids].sort() });
      return source.read(partition, ids);
    },
    count: (partition) => source.count(partition),
  };
  return { reads, source: wrapped };
}

test('visible hits pass in their original order with the current subject state', async () => {
  const fake = createFakeSource();
  const a = book(1);
  const b = book(2, '0123');
  const c = book(3);
  for (const subject of [a, b, c]) fake.put(subject);
  fake.put({ ...a, labels: [{ language: 'en', value: 'Renamed' }] });
  const { reads, source } = recording(fake);
  const result = await checkHits(source, [hit(b), hit(a), hit(c)], none);
  expect(result.dropped).toBe(0);
  expect(result.passed.map((entry) => entry.hit.id)).toEqual([b.id, a.id, c.id]);
  expect(result.passed[1]!.subject.labels).toEqual([{ language: 'en', value: 'Renamed' }]);
  expect(reads.sort((x, y) => x.partition - y.partition)).toEqual([
    { partition: 10, ids: [a.id, c.id].sort() },
    { partition: 18, ids: [b.id] },
  ]);
});

test('hidden, taken-down, redirected, missing and re-secured hits are dropped', async () => {
  const fake = createFakeSource();
  const subjects = [1, 2, 3, 4, 5, 6].map((n) => book(n));
  const [kept, hidden, takenDown, redirected, missing, resecured] = subjects as [
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
  ];
  for (const subject of subjects) fake.put(subject);
  const hits = subjects.map((subject) => hit(subject));
  fake.put({ ...hidden, visibility: 'hidden' });
  fake.put({ ...takenDown, visibility: 'taken_down', securityRevision: 2 });
  fake.put({ ...redirected, redirect: kept.id });
  fake.remove(missing.id);
  fake.put({ ...resecured, securityRevision: 2 });
  const result = await checkHits(fake, hits, none);
  expect(result.passed.map((entry) => entry.hit.id)).toEqual([kept.id]);
  expect(result.dropped).toBe(5);
});

test('a hit that names another partition than its anchor is dropped without reading there', async () => {
  const fake = createFakeSource();
  const a = book(1);
  fake.put(a);
  const { reads, source } = recording(fake);
  expect(await checkHits(source, [{ ...hit(a), partition: 18 }], none)).toEqual({ passed: [], dropped: 1 });
  expect(reads).toEqual([]);
});

test('matched filter clauses must still hold on the current facts', async () => {
  const fake = createFakeSource();
  const subjects = [1, 2, 3, 4].map((n) => book(n));
  const [stillBy, nowByOther, nowRecipe, textOnly] = subjects as [
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
  ];
  for (const subject of subjects) fake.put(subject);
  fake.put({ ...nowByOther, statements: [{ property: 'schema:author', value: other }] });
  fake.put({ ...nowRecipe, type: 'schema:Recipe' });
  fake.put({ ...textOnly, type: 'schema:Recipe' });
  const clauses = new Map<string, FactClause>([
    ['f0', { facet: 'type', values: ['schema:Book'] }],
    ['f1', { facet: 'statement', property: 'schema:author', values: [author] }],
  ]);
  const result = await checkHits(
    fake,
    [hit(stillBy, ['t0', 'f0', 'f1']), hit(nowByOther, ['f1']), hit(nowRecipe, ['t0', 'f0']), hit(textOnly, ['t0'])],
    clauses,
  );
  expect(result.passed.map((entry) => entry.hit.id)).toEqual([stillBy.id, textOnly.id]);
  expect(result.dropped).toBe(2);
});

test('partitions are read once each with bounded concurrency', async () => {
  const fake = createFakeSource();
  const route = (partition: number) => (partition * 16).toString(16).padStart(4, '0');
  const subjects = Array.from({ length: 20 }, (_, index) => book(index + 1, route(Math.floor(index / 2) + 1)));
  for (const subject of subjects) fake.put(subject);
  let active = 0;
  let peak = 0;
  const partitions: number[] = [];
  const slow: SubjectSource = {
    read: async (partition, ids) => {
      partitions.push(partition);
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return fake.read(partition, ids);
    },
    count: (partition) => fake.count(partition),
  };
  const result = await checkHits(
    slow,
    subjects.map((subject) => hit(subject)),
    none,
    { concurrency: 3 },
  );
  expect(result.passed).toHaveLength(20);
  expect(partitions.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(peak).toBe(3);
});

test('a failed read fails the whole check closed', async () => {
  const fake = createFakeSource();
  const a = book(1);
  const b = book(2, '0123');
  fake.put(a);
  fake.put(b);
  const failing: SubjectSource = {
    read: (partition, ids) =>
      partition === 18 ? Promise.reject(new Error('partition unavailable')) : fake.read(partition, ids),
    count: (partition) => fake.count(partition),
  };
  await expect(checkHits(failing, [hit(a), hit(b)], none)).rejects.toThrow('partition unavailable');
});

test('range and qualifier rechecks require one current statement with the right facet and unit', async () => {
  const fake = createFakeSource();
  const qualifiers = [
    { property: 'rezics:role', in: [author] },
    { property: 'rezics:credit', in: [other] },
  ];
  const clause: FactClause = {
    facet: 'statement',
    property: 'schema:totalTime',
    range: { gte: 30, lte: 60, unit: 'unit:MIN' },
    qualifiers,
  };
  const minutes = (
    amount: number,
    unit = 'unit:MIN',
    roles = [
      { property: 'rezics:role', value: author },
      { property: 'rezics:credit', value: other },
    ],
  ): IndexedSubject['statements'][number] => ({
    property: 'schema:totalTime',
    value: 'quantity',
    facet: { kind: 'quantity', amount, unit },
    qualifiers: roles,
  });
  const statements = [
    [minutes(30)],
    [minutes(60)],
    [minutes(45, 'unit:HUR')],
    [minutes(29)],
    [minutes(61)],
    [
      minutes(45, 'unit:MIN', [{ property: 'rezics:role', value: author }]),
      minutes(45, 'unit:MIN', [{ property: 'rezics:credit', value: other }]),
    ],
    [{ ...minutes(45), facet: { kind: 'time' as const, year: 45 } }],
    [{ ...minutes(45), property: 'schema:other' }],
    [{ property: 'schema:totalTime', value: 'quantity' }],
  ];
  const subjects = statements.map((statements, index) => ({ ...book(index + 1), statements }));
  for (const subject of subjects) fake.put(subject);
  const result = await checkHits(
    fake,
    subjects.map((subject) => hit(subject, ['f0'])),
    new Map([['f0', clause]]),
  );
  expect(result.passed.map(({ subject }) => subject.id)).toEqual(subjects.slice(0, 2).map((subject) => subject.id));
  expect(result.dropped).toBe(subjects.length - 2);

  const time: FactClause = { facet: 'statement', property: 'schema:totalTime', range: { gte: 45, lte: 45 } };
  const years = await checkHits(
    fake,
    subjects.map((subject) => hit(subject, ['f0'])),
    new Map([['f0', time]]),
  );
  expect(years.passed.map(({ subject }) => subject.id)).toEqual([subjects[6]!.id]);
});

// Native authority stays in semantic Source and real Access. Corruption below only
// changes clones of observations that actually executed against the check database.
describe('native request Source observation boundary', () => {
  const partition = 174;
  const route = partition * 16;
  const ids = Array.from({ length: 257 }, () => newId(route)).sort();
  const concept = newId(route);
  const foreign = newId(route + 16);
  const missing = newId(route);
  const prefix = `request-source-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(75)]]) };
  const routeKey = new Uint8Array(32).fill(76);
  const actions = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide', 'moderation:takedown'];
  let db: GrowthDatabase;
  let native: SubjectSource;
  let search: ReturnType<typeof createOpenSearch>;
  let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
  let access: Access;
  let kernel: ReturnType<typeof createKernel>;
  let original: IndexedSubject[];
  let extra: IndexedSubject;
  let indexCreated = false;

  async function post(path: string, body: unknown) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${crypto.randomUUID()}"`,
        },
        body: JSON.stringify(body),
      }),
    );
    expect([path, response.status, await response.json()]).toEqual([path, 200, expect.anything()]);
  }

  beforeAll(async () => {
    db = await openGrowthDatabase();
    const searchUrl = process.env.OPENSEARCH_URL;
    if (!searchUrl) throw new Error('OPENSEARCH_URL must name the check node');
    search = createOpenSearch(searchUrl);
    native = subjectSource(db.pool, routeKey);
    await bootstrapRelease(db.pool, bundledRelease);
    real = await createRealAccess(db.admin, { editor: newId(0) }, actions);
    kernel = createKernel({
      pool: db.pool,
      tokens,
      routeKey,
      writeRate: real.writeRate,
      access(config) {
        return (access = real.access(config));
      },
    });
    for (const action of [...actions, 'gate:subject_identity'])
      await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    await kernel.handle(new Request(`http://kernel.test/v1/definitions/releases/${bundledDigest}`));
    for (const target of [concept, ...ids, foreign]) {
      const home = subjectPartition(target);
      const deadline = deadlineFor(5000);
      const actor = await access.authenticate(real.bearer('editor'), { pool: db.pool, deadline });
      if (actor.kind !== 'account') throw new Error('Expected authenticated editor');
      const created = await createSubject(db.pool, {
        actor,
        target: { route: home * 16, id: target },
        idempotencyKey: crypto.randomUUID(),
        digest: new Uint8Array(32).fill(1),
        item: {
          type: target === concept ? 'skos:Concept' : 'schema:Book',
          labels: { en: target === concept ? 'Native genre' : 'Boundary book' },
          ...(target === concept
            ? {}
            : {
                statements: {
                  'schema:genre': [{ property: { id: 'schema:genre' }, value: { type: 'value', content: concept } }],
                },
              }),
        },
        release: { digest: bundledDigest, release: bundledRelease },
        deadline,
        authorization: resourceAuthorization({
          access,
          actor,
          action: 'subject:create',
          anchor: globalContextAnchor,
          context: { pool: db.pool, deadline, partition: home },
        }),
      });
      expect(created.subject.id).toBe(target);
    }
    original = [];
    for (let offset = 0; offset < ids.length; offset += 256)
      original.push(...(await native.read(partition, ids.slice(offset, offset + 256))).subjects);
    extra = (await native.read(partition + 1, [foreign])).subjects[0]!;
    await createSubjectIndex(search, prefix, 1);
    indexCreated = true;
    // The index holds genuinely executed pre-control snapshots, not invented private facts.
    for (let offset = 0; offset < ids.length; offset += 256) {
      const chunk = ids.slice(offset, offset + 256);
      await search.bulk(bulkLines(index, documentActions(await native.read(partition, chunk), chunk)), {
        query: { refresh: 'wait_for' },
      });
    }
    await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    await post(`/v1/subjects/${ids[251]}:hide`, { reason: 'spam' });
    await post(`/v1/subjects/${ids[252]}:takedown`, {
      notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
    });
    await post('/v1/subjects:merge', { subjects: [ids[253], ids[254]] });
    expect(real.checks.filter((check) => check.action === 'subject:create')).toHaveLength(259);
  }, 120_000);

  afterAll(async () => {
    try {
      if (indexCreated) {
        await search.request('DELETE', `/${index}`);
        for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
          await search.request('DELETE', `/_scripts/${prefix}${template}`).catch(() => undefined);
      }
    } finally {
      if (db) await db.close();
    }
  });

  type Edit = (snapshot: SubjectSnapshot) => void;
  function observed(edit?: Edit, occurrence = 1) {
    const reads: { home: number; ids: string[]; snapshot: SubjectSnapshot }[] = [];
    const probes: { home: number; count: number }[] = [];
    const source: SubjectSource = {
      async read(home, selected) {
        const snapshot = await native.read(home, selected);
        reads.push({ home, ids: [...selected], snapshot });
        expect(selected.length).toBeLessThanOrEqual(256);
        expect(new Set(selected).size).toBe(selected.length);
        expect(selected.every((id) => subjectPartition(id) === home)).toBe(true);
        const clone = structuredClone(snapshot);
        if (reads.length === occurrence) edit?.(clone);
        return clone;
      },
      async count() {
        throw new Error('Request hydration must not enumerate');
      },
      ...(native.matchRelationFacets
        ? {
            async matchRelationFacets(
              home: number,
              selected: Parameters<NonNullable<SubjectSource['matchRelationFacets']>>[1],
            ) {
              probes.push({ home, count: selected.length });
              return native.matchRelationFacets!(home, selected);
            },
          }
        : {}),
    };
    return { source, reads, probes };
  }

  test('native current facts, absence, hide, takedown, merge and exact security equality survive chunks 256/257', async () => {
    for (const size of [256, 257]) {
      const selected = ids.slice(0, size);
      const { source, reads } = observed();
      const hits = original.filter((subject) => selected.includes(subject.id)).map((subject) => hit(subject));
      hits.push(
        hit(original[0]!),
        { ...hit(original[0]!), securityRevision: original[0]!.securityRevision + 1 },
        { id: missing, partition, securityRevision: 0, matched: [] },
      );
      const expected = [...selected.filter((id) => !ids.slice(251, 253).includes(id) && id !== ids[254]), ids[0]!];
      const result = await checkHits(source, hits, none);
      expect(result.passed.map(({ subject }) => subject.id)).toEqual(expected);
      expect(result.dropped).toBe(5);
      expect(reads.map((read) => read.ids.length)).toEqual(size === 256 ? [256, 1] : [256, 2]);
      expect(result.passed[0]!.subject.statements).toContainEqual({
        property: 'schema:genre',
        value: concept,
        facet: { kind: 'item' },
      });
      reads.length = 0;
      const facets = await discloseFacetValues(source, [...selected, selected[0]!, missing, 'invalid']);
      expect([...facets.keys()]).toEqual(expected.slice(0, -1));
      expect(reads.map((read) => read.ids.length)).toEqual(size === 256 ? [256, 1] : [256, 2]);
    }
    const { source, reads } = observed();
    expect(await checkHits(source, [{ id: missing, partition, securityRevision: 0, matched: [] }], none)).toEqual({
      passed: [],
      dropped: 1,
    });
    expect([...(await discloseFacetValues(source, [missing])).keys()]).toEqual([]);
    expect(reads.every((read) => read.snapshot.subjects.length === 0)).toBe(true);
    expect(real.checks.some((check) => check.action === 'moderation:hide')).toBe(true);
    expect(real.checks.some((check) => check.action === 'subject:merge')).toBe(true);
  });

  test('direct native helpers bound each unique-key call at exactly 256/257', async () => {
    for (const size of [256, 257]) {
      const selected = ids.slice(0, size);
      for (const surface of ['hits', 'facets']) {
        const { source, reads } = observed();
        if (surface === 'hits')
          await checkHits(
            source,
            original.slice(0, size).map((s) => hit(s)),
            none,
          );
        else await discloseFacetValues(source, selected);
        expect(reads.map((read) => read.ids)).toEqual(
          size === 256 ? [selected] : [selected.slice(0, 256), selected.slice(256)],
        );
      }
    }
  });

  function controls(): [string, Edit][] {
    const record =
      (field: string, value: unknown): Edit =>
      (snapshot) => {
        (snapshot.subjects[0] as unknown as Record<string, unknown>)[field] = value;
      };
    return [
      [
        'wrong home nonempty',
        (s) => {
          s.partition++;
        },
      ],
      [
        'wrong home empty',
        (s) => {
          s.partition++;
          s.subjects = [];
        },
      ],
      [
        'identical duplicate',
        (s) => {
          s.subjects.push(structuredClone(s.subjects[0]!));
        },
      ],
      [
        'different duplicate',
        (s) => {
          s.subjects.push({ ...s.subjects[0]!, visibility: 'hidden' });
        },
      ],
      [
        'foreign extra',
        (s) => {
          s.subjects.push(structuredClone(extra));
        },
      ],
      [
        'same-home extra',
        (s) => {
          s.subjects.push({ ...structuredClone(s.subjects[0]!), id: missing });
        },
      ],
      ['unroutable key', record('id', 'bad-key')],
      [
        'missing key',
        (s) => {
          delete (s.subjects[0] as Partial<IndexedSubject>).id;
        },
      ],
      ...[undefined, null, 0, 1, '1', -1n].map((value): [string, Edit] => [
        `position ${String(value)}`,
        (s) => {
          (s as unknown as Record<string, unknown>).position = value;
        },
      ]),
      ...[undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'].map((value): [string, Edit] => [
        `security ${String(value)}`,
        record('securityRevision', value),
      ]),
      ...[undefined, null, '', 'deleted', 1].map((value): [string, Edit] => [
        `visibility ${String(value)}`,
        record('visibility', value),
      ]),
      ...[undefined, '', 'bad-key', 0].map((value): [string, Edit] => [
        `redirect ${String(value)}`,
        record('redirect', value),
      ]),
      [
        'malformed record',
        (s) => {
          s.subjects[0] = null as never;
        },
      ],
      [
        'sparse records',
        (s) => {
          delete s.subjects[0];
        },
      ],
      [
        'missing records',
        (s) => {
          delete (s as Partial<SubjectSnapshot>).subjects;
        },
      ],
      ['malformed labels', record('labels', [null])],
      ['malformed statements', record('statements', [null])],
      ['malformed overflow', record('relationFacetOverflow', [null])],
    ];
  }

  test('executed native observations reject every boundary corruption on hits and facet labels', async () => {
    for (const [name, edit] of controls()) {
      const selected = original.slice(0, 2).map((subject) => hit(subject));
      const hits = observed(edit);
      await expect(checkHits(hits.source, selected, none), name).rejects.toBeInstanceOf(SearchUnavailableError);
      const facets = observed(edit);
      await expect(
        discloseFacetValues(
          facets.source,
          selected.map((hit) => hit.id),
        ),
        name,
      ).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(hits.probes, name).toEqual([]);
      expect(facets.probes, name).toEqual([]);
    }
    // A valid observation may omit requested keys. It need not observe an indexer's version.
    const omission = observed((s) => {
      s.subjects.splice(0, 1);
      s.position = 0n;
    });
    expect(
      (
        await checkHits(
          omission.source,
          original.slice(0, 2).map((s) => hit(s)),
          none,
        )
      ).passed.map(({ subject }) => subject.id),
    ).toEqual([ids[1]!]);
    const facets = observed((s) => {
      s.subjects.splice(0, 1);
    });
    expect([...(await discloseFacetValues(facets.source, ids.slice(0, 2))).keys()]).toEqual([ids[1]!]);
  });

  test('invalid rejected candidates and later chunks reject the entire page before probes or partial success', async () => {
    const filter = { statement: { property: 'schema:genre', in: [concept] } };
    const invalid = observed((s) => {
      s.subjects[1]!.securityRevision = -1;
    });
    await expect(
      checkHits(invalid.source, [hit(original[0]!), hit(original[251]!)], none, {
        filter,
      }),
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(invalid.probes).toEqual([]);
    for (const surface of ['hits', 'facets']) {
      const invalid = observed((s) => {
        s.partition++;
      }, 2);
      await expect(
        surface === 'hits'
          ? checkHits(
              invalid.source,
              original.map((s) => hit(s)),
              none,
            )
          : discloseFacetValues(invalid.source, ids),
      ).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(invalid.reads.map((read) => read.ids.length)).toEqual([256, 1]);
      expect(invalid.probes).toEqual([]);
    }
    const valid = observed();
    const result = await checkHits(
      valid.source,
      [hit(original[0]!), hit(original[251]!), { id: missing, partition, securityRevision: 0, matched: [] }],
      none,
      { filter },
    );
    expect(result.passed.map(({ subject }) => subject.id)).toEqual([ids[0]!]);
    expect(result.dropped).toBe(2);
    expect(valid.reads[0]!.ids).toEqual([ids[0]!, ids[251]!, missing]);
    expect(valid.probes).toEqual([]);
    // This base's native Source has no relation probe runtime. A controlled
    // overflow marker must fail closed; it cannot manufacture native authority.
    const overflow = observed((s) => {
      s.subjects[0]!.relationFacetOverflow = ['schema:genre'];
    });
    delete overflow.source.matchRelationFacets;
    for (const current of [filter, { not: filter }, { or: [{ type: { in: ['schema:Book'] } }, filter] }]) {
      await expect(checkHits(overflow.source, [hit(original[0]!)], none, { filter: current })).rejects.toThrow();
      // Inject the control independently into the next executed observation too.
      overflow.reads.length = 0;
    }
    expect(overflow.probes).toEqual([]);
  });

  test('native node requests map invalid evidence to retryable 503 index_not_ready for hits and facets', async () => {
    for (const edit of [controls()[0]![1], controls()[1]![1], controls()[2]![1]]) {
      for (const surface of ['hits', 'facets']) {
        const { source } = observed(edit);
        const service = createSearchService({ pool: db.pool, client: search, source, prefix, cursors: tokens });
        const request =
          surface === 'hits'
            ? service.search('anonymous', { text: 'Boundary' })
            : service.facets('anonymous', {
                filter: { type: { in: ['schema:Book'] } },
                facets: [{ property: 'schema:genre' }],
              });
        const error = await request.then(
          () => undefined,
          (error: unknown) => searchOperationProblem(error),
        );
        expect(error).toBeInstanceOf(ProblemError);
        expect((error as ProblemError).code).toBe('index_not_ready');
        const response = problemResponse(error, { method: 'POST', id: crypto.randomUUID() });
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('1');
      }
    }
  });

  test('native fixed-key hydration charges rejects and absence as unrelated records and history grow', async () => {
    const population: Population = {
      name: `request-hydration-${crypto.randomUUID()}`,
      hotPartition: partition,
      hotShare: 1,
      rows: ({ ordinal, route }) => {
        const id = newId(route),
          transaction = crypto.randomUUID();
        return {
          'semantic.subject': [
            {
              route,
              subject_id: id,
              type: 'schema:Book',
              visibility: 'visible',
              security_revision: 0,
              current_facts: 1,
              current_release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          'semantic.fact': itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } }).map((fact) => ({
            ...fact,
            route,
            subject_id: id,
            recorded_transaction_id: transaction,
            release: null,
          })),
          'semantic.revision': [1, 2].map((revision) => ({
            route,
            subject_id: id,
            revision,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transaction,
          })),
        };
      },
    };
    const report = await checkGrowth(db, {
      name: 'Request native Source hydration at fixed keys with unrelated records and history',
      scales: [64, 512, 4096],
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      counted: {
        read: (value) => value as Record<string, number>,
        limits: { reads: 2, keys: 8, candidates: 4, dropped: 3, probes: 0, labels: 1 },
        bounds: { reads: 'constant', keys: 'constant', probes: 'constant' },
      },
      grow: (database, scale, previous) => seed(database, population, { from: previous, to: scale }),
      operation: async () => {
        const observedSource = observed();
        const selected = [ids[0]!, ids[251]!, ids[254]!, missing];
        const result = await checkHits(
          observedSource.source,
          selected.map((id) => ({
            id,
            partition,
            securityRevision: original.find((s) => s.id === id)?.securityRevision ?? 0,
            matched: [],
          })),
          none,
          {
            filter: { statement: { property: 'schema:genre', in: [concept, foreign] } },
          },
        );
        const labels = await discloseFacetValues(observedSource.source, selected);
        expect(result.passed.map(({ subject }) => subject.id)).toEqual([ids[0]!]);
        expect(result.dropped).toBe(3);
        expect([...labels.keys()]).toEqual([ids[0]!]);
        return {
          reads: observedSource.reads.length,
          keys: observedSource.reads.reduce((n, r) => n + r.ids.length, 0),
          candidates: selected.length,
          dropped: result.dropped,
          probes: observedSource.probes.reduce((n, p) => n + p.count, 0),
          labels: labels.size,
        };
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    expect(
      report.samples.every(
        (sample) =>
          sample.cost.plans > 0 &&
          sample.cost.rows > 0 &&
          sample.cost.requestBytes! > 0 &&
          sample.cost.responseBytes! > 0,
      ),
    ).toBe(true);
  }, 120_000);
});

test('controlled malformed observation metadata is rejected before inspecting any current facts', async () => {
  for (const corruption of ['home', 'duplicate', 'extra', 'security']) {
    for (const surface of ['hits', 'facets']) {
      let facts = 0;
      const a = book(700),
        b = book(701);
      const source: SubjectSource = {
        async read(partition) {
          const first = {
            ...a,
            get labels() {
              facts++;
              return a.labels;
            },
          };
          const snapshot = { partition, position: 1n, subjects: [first, b] };
          if (corruption === 'home') snapshot.partition++;
          if (corruption === 'duplicate') snapshot.subjects[1] = { ...b, id: a.id };
          if (corruption === 'extra') snapshot.subjects[1] = { ...b, id: id(702) };
          if (corruption === 'security') snapshot.subjects[1] = { ...b, securityRevision: -1 };
          return snapshot;
        },
        async count() {
          throw new Error('No enumeration');
        },
      };
      await expect(
        surface === 'hits' ? checkHits(source, [hit(a), hit(b)], none) : discloseFacetValues(source, [a.id, b.id]),
      ).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(facts).toBe(0);
    }
  }
});
