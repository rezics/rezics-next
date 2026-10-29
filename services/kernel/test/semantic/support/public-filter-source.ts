import { expect } from 'bun:test';
import { releaseDigest, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { systemClock } from '../../../src/clock.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../../src/command/command.ts';
import { randomUUID } from 'node:crypto';
import { actionCatalogue } from '../../../src/http/request.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { activeRelease } from '../../../src/semantic/definitions.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { partitionOf, routeOf, newId } from '../../../src/route/route.ts';
import type {
  PublicFilterProjectionFrontier,
  PublicFilterProjectionMeaning,
  PublicFilterProjectionRecord,
  PublicFilterRepairLocator,
  PublicFilterSource,
  PublicFilterSourceFactory,
  RecordPrivacyReduction,
  PrivacyReductionHead,
} from '../../../src/semantic/public-filter-source-contract.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { createRealAccess } from '../real-access.ts';

export const readContext = () => ({ deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) });
/** Existing concrete-only cases must fail if a producer unexpectedly drops scalar coverage. */
export function indexed(record: PublicFilterProjectionRecord) {
  expect(record.indexed, `Unexpected unresolved native statement ${record.candidate}`).not.toBeNull();
  if (record.indexed === null) throw new Error('Concrete fixture lost indexed representation');
  return record.indexed;
}

export const producerModule = '../../../src/semantic/public-filter-source.ts';
export async function nativeProducer(): Promise<{
  publicFilterSource: PublicFilterSourceFactory;
  recordPrivacyReduction: RecordPrivacyReduction;
}> {
  const path = new URL(producerModule, import.meta.url).pathname;
  expect(
    await Bun.file(path).exists(),
    `Missing native producer ${path}; type-only specification is not runtime proof`,
  ).toBe(true);
  // Variable import deliberately keeps missing production modules out of RootTC0.
  const module = await import(path);
  expect(typeof module.publicFilterSource, 'Missing native publicFilterSource factory').toBe('function');
  expect(typeof module.recordPrivacyReduction, 'Missing same-transaction recordPrivacyReduction').toBe('function');
  return module;
}

export const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
  'source_fence:takedown',
  'definitions:publish',
  'definitions:activate',
  'collection:create',
  'collection:update',
];
export const snak = (id: string, content: unknown) => ({
  property: { id },
  value: { type: 'value' as const, content },
});
export const statement = (id: string, content: unknown, qualifiers: ReturnType<typeof snak>[] = []) => ({
  ...snak(id, content),
  qualifiers,
});

export async function fixture() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const db = await openGrowthDatabase(url);
  const routeKey = new Uint8Array(32).fill(79);
  const accounts = { editor: newId(31000) };
  const real = await createRealAccess(db.admin, accounts, actions);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const release: Release = structuredClone(bundledRelease);
  release.catalogue = { id: 'https://example.test/public-filter', version: '1' };
  release.prefixes.ex = 'https://example.test/';
  release.filters = {};
  for (const name of ['left', 'right']) {
    release.properties[`ex:${name}`] = {
      ...structuredClone(release.properties['wdt:P3831']!),
      iri: `https://example.test/${name}`,
      labels: { en: name },
    };
  }
  release.properties['schema:author']!.qualifiers = ['ex:left', 'ex:right', 'wdt:P1114'];
  release.properties['ex:credit'] = {
    ...structuredClone(release.properties['schema:author']!),
    iri: 'https://example.test/credit',
    labels: { en: 'Credit' },
    relation: { group: 'credit', inverse: 'none', order: 'name', slotKey: 'ex:left' },
  };
  release.types['schema:Book']!.properties.push('ex:credit');
  release.types['schema:Organization']!.facets = ['rezics:penNameOf'];
  release.types['schema:Book']!.facets = ['schema:author', 'schema:inLanguage', 'ex:credit'];
  await bootstrapRelease(db.pool, release);
  const digest = releaseDigest(release);
  const kernel = createKernel({
    pool: db.pool,
    routeKey,
    access: real.access,
    clock: systemClock,
    writeRate: createWriteRateLimiter({
      secret: 'public-filter-native-fixture',
      overrides: JSON.stringify(
        Object.fromEntries(
          ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((name) => [
            name,
            { write: { maximum: 100000, seconds: 60 } },
          ]),
        ),
      ),
    }),
  });
  let session: string | null = null;
  async function call(path: string, body: unknown, key: string = randomUUID(), method = 'POST') {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
          ...(session ? { 'rezics-session-token': session } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    session = response.headers.get('rezics-session-token') ?? session;
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }
  async function post(path: string, body: unknown, key?: string) {
    const result = await call(path, body, key);
    expect([result.status, result.body.code], `${path}: ${JSON.stringify(result.body)}`).toEqual([
      path.endsWith('/subjects') ||
      path.endsWith('/candidates') ||
      path.endsWith('/releases') ||
      path.endsWith('/collections')
        ? 201
        : 200,
      undefined,
    ]);
    return result.body;
  }
  async function create(type = 'schema:Person', statements: Record<string, unknown[]> = {}, key?: string) {
    return (await post('/v1/subjects', { type, labels: { en: 'Native public filter' }, statements }, key)).subject
      .id as string;
  }
  async function propose(subject: string, value: string) {
    return (
      await post(`/v1/subjects/${subject}/candidates`, {
        statement: {
          ...statement('schema:author', value),
          references: [{ parts: [snak('schema:url', 'https://example.test/source')] }],
        },
      })
    ).candidate as string;
  }
  const active = await activeRelease(db.pool);
  if (active?.digest !== digest) {
    await post('/v1/definitions/releases', { release });
    await post(`/v1/definitions/releases/${digest}:activate`, { expected_head: active?.head ?? null });
  }
  const config = {
    pool: db.pool,
    routeKey,
    clock: systemClock,
    access: real.access({ actions: actionCatalogue(kernel), clock: systemClock }),
  };
  const meaning: PublicFilterProjectionMeaning = { digest, release, type: 'schema:Book' };
  return { db, real, accounts, config, meaning, create, propose, post, call, close: () => db.close() };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const home = (subject: string) => partitionOf(routeOf(subject)!);

export async function head(source: PublicFilterSource, partition: number): Promise<PrivacyReductionHead> {
  const page = await source.readPrivacyReductionHeads({ kind: 'home', partition, context: readContext() });
  expect(page.status).toBe('home');
  if (page.status !== 'home') throw new Error(`Native privacy head ${page.status}`);
  expect(page.head.partition).toBe(partition);
  return page.head;
}

export async function capturedStep<
  T extends { cost: import('../../../src/semantic/public-filter-source-contract.ts').PublicFilterCost },
>(db: GrowthDatabase, work: () => Promise<T>): Promise<T> {
  const measured = await capture(db, work, { includeBackends: true });
  const physical = costOf(measured.capture);
  const { cost } = measured.value;
  for (const value of Object.values(cost)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
  expect(cost.inputKeys).toBeLessThanOrEqual(1000);
  expect(cost.candidates).toBeLessThanOrEqual(cost.inputKeys);
  expect(cost.accessPoints + cost.dependencyPoints).toBeLessThanOrEqual(8 * cost.inputKeys);
  expect(cost.resultWrites).toBeLessThanOrEqual(1000);
  expect(cost.frontierWrites).toBeLessThanOrEqual(1);
  expect(cost.engineSearches).toBeLessThanOrEqual(4);
  expect(physical.rows).toBeLessThanOrEqual(64 + 16 * cost.inputKeys);
  expect(physical.blocks).toBeLessThanOrEqual(6 * (64 + 16 * cost.inputKeys));
  expect(physical.responseBytes).toBeDefined();
  expect(physical.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
  const backends = measured.capture.statementBackends;
  expect(backends).toBeDefined();
  for (const backend of new Set(backends)) {
    expect(measured.capture.statements.filter((_, i) => backends![i] === backend).length).toBeLessThanOrEqual(16);
  }
  // Capture retains statements, backend IDs, removed rows in plans and wire bytes; no catalogue exemption.
  return measured.value;
}

export async function complete(
  f: Fixture,
  source: PublicFilterSource,
  subject: string,
  frontier: PublicFilterProjectionFrontier | null = null,
) {
  const records: PublicFilterProjectionRecord[] = [];
  const repairLocators: PublicFilterRepairLocator[] = [];
  let steps = 0;
  let inputKeys = 0;
  for (;;) {
    const page = await capturedStep(f.db, () =>
      source.readPublicFilterProjectionPage({
        subject,
        meaning: f.meaning,
        inputLimit: 16,
        frontier,
        context: readContext(),
      }),
    );
    expect(['progress', 'complete']).toContain(page.status);
    if (page.status !== 'progress' && page.status !== 'complete') throw new Error(`Native projection ${page.status}`);
    expect(page.cost.inputKeys).toBeLessThanOrEqual(16);
    inputKeys += page.cost.inputKeys;
    records.push(...page.records);
    repairLocators.push(...page.repairLocators);
    expect(++steps, 'Finite quiescent input must not restart at zero forever').toBeLessThan(10000);
    if (page.status === 'complete') return { records, repairLocators, page, steps, inputKeys };
    expect(page.frontier).not.toEqual(frontier);
    frontier = JSON.parse(
      JSON.stringify(page.frontier, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
    );
    // Preserve the lossless native bigint across a process-style retained frontier reload.
    frontier = { ...frontier!, generation: BigInt(frontier!.generation) };
  }
}

/** Use the Search-owned native fixture; no consumer/ACK or source registration is manufactured here. */
export async function consumerFixture(f: Fixture, source: PublicFilterSource) {
  const { createPublicFilterConsumerFixture } = await import('../../search/support/public-filter-consumer.ts');
  const { createOpenSearch } = await import('../../../src/search/opensearch.ts');
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the configured native engine');
  return createPublicFilterConsumerFixture({
    pool: f.db.pool,
    source,
    clock: f.config.clock,
    context: readContext(),
    search: createOpenSearch(url),
    meaning: f.meaning,
  });
}

export async function settleConsumer(
  consumer: import('../../search/support/public-filter-consumer.ts').PublicFilterConsumerFixture,
  job: import('../../../src/search/public-filter-consumer-contract.ts').PublicFilterConsumerJob,
) {
  for (let step = 0; step < 10000; step++) {
    const result = await consumer.operations.repairStep(job, readContext());
    expect(['progress', 'settled']).toContain(result.status);
    if (result.status === 'settled') return;
  }
  throw new Error('Finite native repair did not settle');
}

export async function capturedConsumer(
  f: Fixture,
  consumer: import('../../search/support/public-filter-consumer.ts').PublicFilterConsumerFixture,
  plan: import('../../../src/search/public-filter-consumer-contract.ts').PublicFilterConsumerCaptureInput,
  snapshot: 'pit' | 'prepared' = 'pit',
) {
  for (let step = 0; step < 10000; step++) {
    const result = await consumer.operations.capture({ plan, snapshot }, readContext());
    expect(['captured', 'preparing']).toContain(result.status);
    if (result.status === 'preparing') await settleConsumer(consumer, result.repair);
    if (result.status === 'captured') {
      expect(result.queried.consumer.physicalTarget).toBe(consumer.physicalTarget);
      expect(result.queried.consumer.incarnation).toBe(await consumer.incarnation());
      expect(result.queried.consumer.meaningDigest).toBe(f.meaning.digest);
      expect(result.queried.consumer.readDefinition).toBeString();
      expect(result.queried.consumer.readDefinition!.length).toBeGreaterThan(0);
      expect(result.queried.snapshot.kind).toBe(snapshot);
      return result;
    }
  }
  throw new Error('Finite native capture did not finish');
}

/** Two independent assertions on ONE inclusive native query+status capture. No harness API is added. */
export async function assertPageCapture(
  label: string,
  whole: import('../../support/growth.ts').Capture,
  query: Extract<
    import('../../../src/search/public-filter-consumer-contract.ts').PublicFilterConsumerQuery,
    { status: 'queried' }
  >,
  final: Extract<
    import('../../../src/search/public-filter-consumer-contract.ts').PublicFilterConsumerStatus,
    { status: 'observed' }
  >,
  size: number,
) {
  const { isControlStatement } = await import('../../support/growth.ts');
  const role = (text: string) => /^\/\* semantic\.(privacy-start|privacy-final|own-rows) \*\//.exec(text)?.[1];
  const coverageRole = (text: string) => ['privacy-start', 'privacy-final'].includes(role(text) ?? '');
  // Keep raw native evidence before assertions, including failures of attribution or numerical bounds.
  const evidence = new URL(`../../../../../.temp/goal/semantic/${label}.json`, import.meta.url);
  await Bun.write(
    evidence,
    JSON.stringify({ whole, query, final }, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
  expect(whole.statementBackends).toHaveLength(whole.statements.length);
  expect(whole.planBackends).toHaveLength(whole.plans.length);
  expect(whole.requestBytes).toHaveLength(whole.statements.length);
  expect(whole.responseBytes).toHaveLength(whole.statements.length);
  expect(whole.statementErrors).toEqual(whole.statements.map(() => null));
  const plans = whole.plans.flatMap((document, i) => {
    const entries: unknown[] = Array.isArray(document) ? document : [document];
    return entries.map((entry) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('Query Text' in entry) ||
        typeof entry['Query Text'] !== 'string'
      )
        throw new Error('Native plan is missing SQL Query Text for semantic role attribution');
      return { document: entry, text: entry['Query Text'], backend: whole.planBackends![i] };
    });
  });
  const key = (text: string, backend: number | undefined) => JSON.stringify([backend, text]);
  expect(plans.map(({ text, backend }) => key(text, backend)).sort()).toEqual(
    whole.statements
      .flatMap((text, i) => (isControlStatement(text) ? [] : [key(text, whole.statementBackends![i])]))
      .sort(),
  );
  const indices = whole.statements.flatMap((text, i) => (coverageRole(text) ? [i] : []));
  const coveragePlans = plans.filter(({ text }) => coverageRole(text));
  const coverage: import('../../support/growth.ts').Capture = {
    statements: indices.map((i) => whole.statements[i]!),
    plans: coveragePlans.map(({ document }) => document),
    statementBackends: indices.map((i) => whole.statementBackends![i]),
    planBackends: coveragePlans.map(({ backend }) => backend),
    requestBytes: indices.map((i) => whole.requestBytes![i]!),
    responseBytes: indices.map((i) => whole.responseBytes![i]!),
    statementErrors: indices.map((i) => whole.statementErrors![i]!),
  };
  await Bun.write(
    evidence,
    JSON.stringify({ whole, coverage, query, final }, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
  // Missing/untagged coverage never counts as a free zero. Every actual role has exactly ONE prefix.
  expect(coverage.statements.map(role).sort()).toEqual(['privacy-final', 'privacy-start']);
  for (const text of whole.statements.filter((text) => role(text) !== undefined)) {
    const rest = text.replace(/^\/\* semantic\.(privacy-start|privacy-final|own-rows) \*\//, '');
    expect(/\/\* semantic\.(privacy-start|privacy-final|own-rows) \*\//.test(rest)).toBe(false);
  }
  const privacy = costOf(coverage);
  expect(privacy.plans).toBe(coverage.statements.length);
  expect(privacy.statements).toBeLessThanOrEqual(2);
  const behind = new Set(final.pending.map((head) => head.partition));
  const changed = new Set(final.changed.map((head) => head.partition));
  expect(privacy.rows).toBeLessThanOrEqual(64 + 2 * (behind.size + changed.size));
  const work = costOf(whole);
  const costs = [query.cost, final.cost];
  for (const cost of costs)
    for (const count of Object.values(cost)) expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
  const candidates = costs.reduce((sum, cost) => sum + cost.candidates, 0);
  expect(candidates).toBeLessThanOrEqual(Math.min(600, 6 * size + 3));
  expect(costs.reduce((sum, cost) => sum + cost.accessPoints + cost.dependencyPoints, 0)).toBeLessThanOrEqual(
    16 + 8 * candidates,
  );
  expect(costs.reduce((sum, cost) => sum + cost.engineSearches, 0)).toBeLessThanOrEqual(6);
  expect(costs.reduce((sum, cost) => sum + cost.outputSlots, 0)).toBeLessThanOrEqual(size);
  expect(work.rows).toBeLessThanOrEqual(64 + 16 * candidates);
  expect(work.blocks).toBeLessThanOrEqual(6 * (64 + 16 * candidates));
  expect(work.requestBytes).toBeDefined();
  expect(work.responseBytes).toBeDefined();
  expect(work.requestBytes!).toBeLessThanOrEqual(64 * 1024 + 1024 * candidates);
  expect(work.responseBytes!).toBeLessThanOrEqual(16 * 1024 + 4096 * candidates);
  const backends = new Set(whole.statementBackends);
  expect(backends.has(undefined)).toBe(false);
  expect(backends.size).toBeLessThanOrEqual(1);
  for (const backend of backends)
    expect(
      whole.statements.filter((text, i) => whole.statementBackends![i] === backend && !isControlStatement(text)).length,
    ).toBeLessThanOrEqual(12);
}
