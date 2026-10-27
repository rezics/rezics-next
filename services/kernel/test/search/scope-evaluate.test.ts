import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FilterDocument } from '@rezics/filter';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { classifyUnavailability } from '../../src/access/unavailable.ts';
import { createKernel, createKernelAccessResolver } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import {
  createSearchScopeSource,
  type ScopeNativeBudget,
  type ScopeEvaluationReservation,
} from '../../src/search/scope-source.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  installTemplates,
  searchSubjects,
  FACET_TEMPLATE,
  SEARCH_TEMPLATE,
  SUGGEST_TEMPLATE,
} from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type RelationFacetMatch, type SubjectSource } from '../../src/search/source.ts';
import { activeRelease } from '../../src/semantic/definitions.ts';
import * as semantic from '../../src/semantic/search-source.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';
import { closeOwnedSemanticAuth } from '../semantic/outcome-auth.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

type NativeBudget = ScopeNativeBudget;
type Runtime = Parameters<typeof createSearchService>[0];
type ScopeFactory = typeof createSearchScopeSource;
const ample: ScopeEvaluationReservation = {
  rawKeys: 256,
  native: { points: 256, witnesses: 8192, rows: 65536, bytes: 4 * 1024 * 1024, emptySeeks: 256 },
};
const books: FilterDocument = { type: { in: ['schema:Book'] } };
const people: FilterDocument = { type: { in: ['schema:Person'] } };
const relation = (values: string[]): FilterDocument => ({ statement: { property: 'schema:author', in: values } });
const within = (leaf: FilterDocument): FilterDocument => ({ and: [books, leaf] });
const part = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
const statement = (property: string, content: unknown, qualifiers: ReturnType<typeof part>[] = []) => ({
  ...part(property, content),
  qualifiers,
  rank: 'normal',
});
const prefix = `test-scope-${randomUUID().replaceAll('-', '').slice(0, 24)}-`;
const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
const engineCalls: string[] = [];
const searchesSince = (offset: number) =>
  engineCalls.slice(offset).filter((path) => /\/_(?:m?search|count)(?:\/|$)/.test(path));
const client: OpenSearch = {
  bulk: (...args) => engine.bulk(...args),
  async request<T>(...args: Parameters<OpenSearch['request']>) {
    engineCalls.push(args[1]);
    return engine.request<T>(...args);
  },
};
let driver: SemanticOutcomeDriver;
let db: GrowthDatabase;
let runtime: Runtime;
let source: SubjectSource;
let routeKey: Uint8Array;
let lagged: string;
let empty: string;
let target: string;
let other: string;
let role: string;
let access: Access;
let baseFacetsBuilt = false;

async function write(path: string, body: unknown, persona: 'editor' | 'acceptor' | 'steward' = 'editor') {
  const response = await driver.request(persona, 'POST', path, body, { 'Idempotency-Key': `"${randomUUID()}"` });
  expect(response.status, JSON.stringify({ path, body: response.body })).toBe(
    path === '/v1/subjects' || path === '/v1/definitions/releases' || path.endsWith('/candidates') ? 201 : 200,
  );
  return response.body;
}
async function create(type = 'schema:Book', statements: Record<string, unknown[]> = {}): Promise<string> {
  const result = await write('/v1/subjects', { type, labels: { en: `Scope evaluation ${randomUUID()}` }, statements });
  return (result.subject as { id: string }).id;
}
async function factory(): Promise<ScopeFactory> {
  // Resolving is deliberately later than actual Auth setup, active release, writes and real index creation.
  const path = new URL('../../src/search/scope-source.ts', import.meta.url);
  expect(await Bun.file(path).exists(), 'missing createSearchScopeSource native point evaluation capability').toBe(
    true,
  );
  const module = await import(path.href);
  expect(
    typeof module.createSearchScopeSource,
    'missing createSearchScopeSource native point evaluation capability',
  ).toBe('function');
  return module.createSearchScopeSource as ScopeFactory;
}
async function scope(pool: Pool = db.pool) {
  const createScope = await factory();
  // Underfilled snapshots are not negative evidence. Finish actual owner fixture work first;
  // this flag is never passed to the runtime as an identity readiness claim.
  if (!baseFacetsBuilt) {
    await rebuildRelations([lagged, empty]);
    baseFacetsBuilt = true;
  }
  const native = semantic.subjectSource(pool, routeKey);
  const deadline = Date.now() + 60_000;
  const account = await driver.fixtures.person('editor');
  const actor = await access.authenticate(account.bearer, { pool, deadline });
  return createScope({ ...runtime, pool, source: native, evidence: { access, actor, routeKey, deadline } });
}
async function evaluate(filter: FilterDocument, ids: string[], budget: ScopeEvaluationReservation = ample) {
  const owner = await scope();
  const prepared = await owner.prepare(filter);
  const before = engineCalls.length;
  const measured = await capture(db, () => owner.evaluate(prepared, ids, budget));
  const result = measured.value;
  expect(searchesSince(before), 'explicit IDs must use native points, never another engine search').toEqual([]);
  expect(result.values).toHaveLength(ids.length);
  for (const key of Object.keys(budget.native) as (keyof NativeBudget)[]) {
    expect(Number.isSafeInteger(result.usage.native[key])).toBe(true);
    expect(result.usage.native[key]).toBeGreaterThanOrEqual(0);
    expect(result.usage.native[key]).toBeLessThanOrEqual(budget.native[key]);
  }
  expect(result.usage.keys).toBeGreaterThanOrEqual(0);
  expect(result.usage.keys).toBeLessThanOrEqual(budget.rawKeys);
  expect(result.evidence).toBeDefined();
  if (result.values.includes(true)) {
    expect(result.usage.keys).toBeGreaterThan(0);
    expect(result.usage.native.points).toBeGreaterThan(0);
    expect(result.usage.native.rows).toBeGreaterThan(0);
    expect(costOf(measured.capture).rows).toBeGreaterThan(0);
  }
  return result;
}

beforeAll(async () => {
  driver = await createSemanticDriver(
    (config) => {
      routeKey = config.routeKey!;
      runtime = {
        pool: config.pool,
        client,
        prefix,
        source: semantic.subjectSource(config.pool, routeKey),
        cursors: config.tokens!,
      };
      const resolver = createKernelAccessResolver({
        pool: config.pool,
        tokens: config.tokens!,
        clock: config.clock ?? (() => new Date()),
        ...(config.access === undefined ? {} : { access: config.access }),
      });
      return createKernel({
        ...config,
        search: createSearchService(runtime),
        realmRoleReader: resolver.realmRoleReader,
        access: (catalogue) => (access = resolver.resolveAccess(catalogue)),
      });
    },
    { strictCleanup: true },
  );
  db = await openGrowthDatabase(driver.fixtures.runtime.databaseUrl);
  source = semantic.subjectSource(db.pool, routeKey);
  // A genuine published release admits a qualifier on a descriptive code facet. Relation qualifiers remain refused.
  const release = structuredClone(bundledRelease);
  release.catalogue.version = 'scope-evaluation';
  release.properties['schema:inLanguage']!.qualifiers = ['wdt:P3831'];
  const before = await activeRelease(db.pool);
  expect(before).not.toBeNull();
  const published = await write('/v1/definitions/releases', { release }, 'steward');
  const digest = published.digest;
  if (typeof digest !== 'string') throw new Error('Native release publication did not return a digest');
  await write(`/v1/definitions/releases/${digest}:activate`, { expected_head: before!.head }, 'steward');
  expect((await activeRelease(db.pool))!.digest).toBe(digest);
  target = await create('schema:Person');
  other = await create('schema:Person');
  role = await create('skos:Concept');
  lagged = await create('schema:Book', {
    'schema:author': [statement('schema:author', target)],
    'schema:inLanguage': [statement('schema:inLanguage', 'ja', [part('wdt:P3831', role)])],
    'schema:datePublished': [
      statement('schema:datePublished', {
        time: '+2026-01-01T00:00:00Z',
        precision: 11,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      }),
    ],
  });
  empty = await create();
  expect((await driver.request('anonymous', 'GET', `/v1/subjects/${lagged}`)).status).toBe(200);
  expect((await driver.request('suspended', 'GET', `/v1/subjects/${lagged}`)).status).toBe(401);
  await createSubjectIndex(engine, prefix, 1);
  await engine.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  await installTemplates(engine, prefix);
  // No Search runner is started: the empty index is actual index lag, not a synthetic miss or hit.
  expect((await searchSubjects(engine, prefix, { sort: 'id', size: 100 })).hits).toEqual([]);
}, 600_000);

afterAll(async () => {
  // Remove only this fixture's explicit resources, even when a capability assertion failed.
  await db?.close();
  await driver?.close();
  await closeOwnedSemanticAuth();
  await engine.request('DELETE', `/${subjectIndexName(prefix, 1)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
    await engine.request('DELETE', `/_scripts/${prefix}${name}`);
}, 600_000);

test('point evaluation without invented hits shares current complete Boolean semantics and truthful negatives under independent native budgets', async () => {
  const a = relation([target]);
  const b = relation([other]);
  const cases: [FilterDocument, RelationFacetMatch[]][] = [
    [within(a), [true, false]],
    [within({ not: a }), [false, true]],
    [within({ or: [a, b] }), [true, false]],
    [within({ and: [a, b] }), [false, false]],
    [within({ not: { and: [a, b] } }), [true, true]],
    [within({ not: { or: [a, b] } }), [false, true]],
    [{ or: [people, within(a)] }, [true, false]],
  ];
  for (const [filter, expected] of cases)
    expect((await evaluate(filter, [lagged, empty])).values, JSON.stringify(filter)).toEqual(expected);
});

test('native type code range and same-statement qualifier evidence do not need named matched queries', async () => {
  const otherRole = await create('skos:Concept');
  const split = await create('schema:Book', {
    'schema:inLanguage': [
      statement('schema:inLanguage', 'ja', [part('wdt:P3831', role)]),
      statement('schema:inLanguage', 'en', [part('wdt:P3831', otherRole)]),
    ],
  });
  const qualified: FilterDocument = {
    statement: { property: 'schema:inLanguage', in: ['ja'], qualifiers: [{ property: 'wdt:P3831', in: [role] }] },
  };
  const range: FilterDocument = { statement: { property: 'schema:datePublished', range: { gte: 2026, lte: 2026 } } };
  expect((await evaluate({ and: [books, qualified, range] }, [empty, lagged, target, lagged])).values).toEqual([
    false,
    true,
    false,
    true,
  ]);
  const wrongRole: FilterDocument = {
    statement: { property: 'schema:inLanguage', in: ['ja'], qualifiers: [{ property: 'wdt:P3831', in: [otherRole] }] },
  };
  expect((await evaluate(within(wrongRole), [lagged, split])).values).toEqual([false, false]);
  expect((await evaluate(within({ not: wrongRole }), [lagged])).values).toEqual([true]);
  expect(
    (await evaluate(within({ statement: { property: 'schema:datePublished', range: { lte: 2025 } } }), [lagged]))
      .values,
  ).toEqual([false]);
});

test('actual hit lineage is only a work-order hint and shares the complete point Boolean evaluator', async () => {
  const owner = await scope();
  const filter: FilterDocument = within({ or: [relation([target]), relation([other])] });
  const prepared = await owner.prepare(filter);
  const snapshot = await source.read(subjectPartition(lagged), [lagged]);
  expect(snapshot.subjects).toHaveLength(1);
  expect(
    (
      await engine.bulk<{ errors: boolean }>(
        bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, [lagged])),
        { query: { refresh: 'wait_for' } },
      )
    ).errors,
  ).toBe(false);
  const compiled = compileFilter(filter, { prefix: 'scope-proof-', relationOverflow: true });
  const actual = await searchSubjects(engine, prefix, {
    filter: compiled.query,
    sort: 'id',
    size: 100,
    overflowProperties: ['schema:author'],
  });
  expect(actual.hits.map(({ id }) => id)).toEqual([lagged]);
  expect(actual.hits[0]!.matched.length).toBeGreaterThan(0);
  expect(actual.hits[0]!.matched.length).toBeLessThan(compiled.leaves.length);
  const checked = await checkHits(source, actual.hits, new Map(compiled.leaves.map((leaf) => [leaf.name, leaf])), {
    filter,
  });
  expect(checked.passed.map(({ subject }) => subject.id)).toEqual([lagged]);
  const before = engineCalls.length;
  expect((await owner.evaluate(prepared, [lagged, empty], ample)).values).toEqual([true, false]);
  expect(searchesSince(before)).toEqual([]);
});

type RebuildRunner = { run(partition: number): Promise<{ status: string; examined: number; done: boolean }> };
async function rebuildRelations(ids: string[]) {
  const makeRunner = (
    semantic as unknown as {
      relationFacetRebuilds?: (options: {
        pool: Pool;
        routeKey: Uint8Array;
        consumer: string;
        pageSize: number;
      }) => RebuildRunner;
    }
  ).relationFacetRebuilds;
  expect(typeof makeRunner, 'missing native bounded relation facet rebuild prerequisite').toBe('function');
  const runner = makeRunner!({
    pool: db.pool,
    routeKey,
    consumer: `scope_${randomUUID().replaceAll('-', '')}`,
    pageSize: 16,
  });
  for (const partition of new Set(ids.map(subjectPartition))) {
    let done = false;
    for (let page = 0; page < 10000 && !done; page++) {
      const result = await runner.run(partition);
      expect(result.status).toBe('read');
      expect(result.examined).toBeLessThanOrEqual(16);
      done = result.done;
    }
    expect(done).toBe(true);
  }
}
async function overflowFixture() {
  // These are actual command-written relations. Never replace the native source with sampled result arrays.
  const values = [target, other];
  while (values.length < 129) values.push(await create('schema:Person'));
  const id = await create('schema:Book', { 'schema:author': values.map((value) => statement('schema:author', value)) });
  await rebuildRelations([id]);
  const current = (await source.read(subjectPartition(id), [id])).subjects[0]!;
  expect(current.relationFacetOverflow).toContain('schema:author');
  const sampled = new Set(current.statements.filter((s) => s.property === 'schema:author').map((s) => s.value));
  expect(sampled.size).toBe(128);
  const omitted = values.find((value) => !sampled.has(value))!;
  expect(omitted).toBeDefined();
  return { id, omitted };
}

test('overflow absence stays unknown through NOT while decisive true OR and false AND settle', async () => {
  await scope(); // Capability assertion follows valid setup and precedes further native prerequisites.
  const { id, omitted } = await overflowFixture();
  const absent = await create('schema:Person');
  const unknown = relation([absent]);
  expect(typeof source.matchRelationFacets, 'missing native relation point prerequisite').toBe('function');
  expect(
    await source.matchRelationFacets!(subjectPartition(id), [
      { subject: id, property: 'schema:author', value: absent },
    ]),
  ).toEqual(['not_proven']);
  const cases: [FilterDocument, RelationFacetMatch][] = [
    [within(relation([omitted])), true],
    [within({ not: relation([omitted]) }), false],
    [within(unknown), 'not_proven'],
    [within({ not: unknown }), 'not_proven'],
    [within({ not: { and: [{ not: unknown }] } }), 'not_proven'],
    [{ or: [books, within(unknown)] }, true],
    [within({ and: [{ not: books }, unknown] }), false],
    [within({ not: { or: [unknown, relation([omitted])] } }), false],
  ];
  for (const [filter, expected] of cases) expect((await evaluate(filter, [id])).values).toEqual([expected]);
}, 600_000);

test('native point witness row byte and empty-seek reservations are independent and charge unresolved work', async () => {
  const owner = await scope();
  const { id } = await overflowFixture();
  const absent = await create('schema:Person');
  const prepared = await owner.prepare(within({ not: relation([absent]) }));
  for (const dimension of Object.keys(ample.native) as (keyof NativeBudget)[]) {
    const budget = { ...ample, native: { ...ample.native, [dimension]: 0 } };
    const before = engineCalls.length;
    const measured = await capture(db, () => owner.evaluate(prepared, [id], budget));
    expect(searchesSince(before)).toEqual([]);
    expect(measured.value.values, dimension).toEqual(['not_proven']);
    expect(budget.native[dimension]).toBe(0);
    expect(measured.value.progress === null || measured.value.progress.subject === id).toBe(true);
    expect(measured.value.usage.native[dimension]).toBe(0);
    expect(measured.value.usage.keys).toBeLessThanOrEqual(budget.rawKeys);
    // Use the shared native statement/row capture, not a local growth classifier or only logical result counts.
    expect(costOf(measured.capture).statements).toBeLessThan(8192);
    if (dimension === 'rows') expect(costOf(measured.capture).rows).toBe(0);
  }
  {
    const rawKeys = 0;
    const measured = await capture(db, () => owner.evaluate(prepared, [id], { ...ample, rawKeys }));
    expect(measured.value.values).toEqual(['not_proven']);
    expect(measured.value.usage.keys).toBeGreaterThanOrEqual(0);
    expect(measured.value.usage.keys).toBeLessThanOrEqual(rawKeys);
    expect(measured.value.progress === null || measured.value.progress.subject === id).toBe(true);
    expect(costOf(measured.capture).statements).toBeLessThan(8192);
  }
  const leaves = Array.from({ length: 31 }, () => relation(Array.from({ length: 64 }, () => randomUUID())));
  const manyLeaves = await owner.prepare({ and: [books, ...leaves] });
  const measured = await capture(db, () =>
    owner.evaluate(manyLeaves, [id], { ...ample, native: { ...ample.native, points: 8 } }),
  );
  expect(measured.value.values).toEqual(['not_proven']);
  expect(measured.value.progress === null || measured.value.progress.subject === id).toBe(true);
  expect(measured.value.usage.native.points).toBeGreaterThanOrEqual(0);
  expect(measured.value.usage.native.points).toBeLessThanOrEqual(8);
  expect(measured.value.usage.keys).toBeLessThanOrEqual(ample.rawKeys);
  expect(costOf(measured.capture).statements).toBeLessThan(8192);
}, 600_000);

test('prepare and positive evidence never authorize hidden or taken-down sources at final revalidation', async () => {
  const id = await create('schema:Book', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  await driver.grant('editor', ['moderation:hide', 'moderation:takedown'], driver.globalContext);
  const owner = await scope();
  const prepared = await owner.prepare(within({ statement: { property: 'schema:inLanguage', in: ['ja'] } }));
  await write(`/v1/subjects/${id}:hide`, { reason: 'Disclosure changes after prepare' });
  expect((await owner.evaluate(prepared, [id], ample)).values).toEqual([false]);
  await write(`/v1/subjects/${id}:restore`, { reason: 'Revalidate restored native evidence' });
  const positive = await owner.evaluate(prepared, [id], ample);
  expect(positive.values).toEqual([true]);
  expect(positive.evidence).toBeDefined();
  expect(positive.usage.keys).toBeGreaterThan(0);
  expect(positive.usage.native.points).toBeGreaterThan(0);
  expect(positive.usage.native.rows).toBeGreaterThan(0);
  await write(`/v1/subjects/${id}:takedown`, {
    notice: { complaint: 'Current native disclosure test', received_at: '2026-10-28T00:00:00Z' },
  });
  expect((await owner.evaluate(prepared, [id], ample)).values).toEqual([false]);
  expect((await driver.request('anonymous', 'GET', `/v1/subjects/${id}`)).status).not.toBe(200);
});

test('native database timeout cannot become a definitive negative or a successful NOT', async () => {
  const limitedPool = db.openPool({ options: '-c statement_timeout=50 -c lock_timeout=50', max: 1 });
  const owner = await scope(limitedPool);
  const prepared = await owner.prepare(within({ not: relation([target]) }));
  const lock = await db.admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE semantic.subject IN ACCESS EXCLUSIVE MODE');
    // A real lock timeout is owner unavailability; no injected arrays, errors or replacement point evaluator.
    let failure: unknown;
    try {
      await owner.evaluate(prepared, [lagged], ample);
    } catch (error) {
      failure = error;
    }
    expect(failure, 'native timeout must reject, never resolve a Boolean result').toBeInstanceOf(Error);
    const reason = failure instanceof ProblemError ? failure.code : classifyUnavailability(failure);
    expect(
      ['deadline', 'contention', 'deadline_exceeded', 'semantic_not_ready', 'partition_unavailable'].includes(
        reason ?? '',
      ),
    ).toBe(true);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
