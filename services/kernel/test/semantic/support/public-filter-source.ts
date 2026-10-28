import { expect } from 'bun:test';
import { releaseDigest, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { randomUUID } from 'node:crypto';
import { actionCatalogue } from '../../../src/http/request.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { activeRelease } from '../../../src/semantic/definitions.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { partitionOf, routeOf, newId } from '../../../src/route/route.ts';
import type {
  PublicFacetFrontier,
  PublicFacetMeaning,
  PublicFacetRecord,
  PublicFilterSource,
  PublicFilterSourceFactory,
  RecordPrivacyReduction,
  PrivacyHead,
} from '../../../src/semantic/public-filter-source-contract.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { createRealAccess } from '../real-access.ts';

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
export const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
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
  release.properties['schema:author']!.qualifiers = ['ex:left', 'ex:right'];
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
  async function call(path: string, body: unknown, key = randomUUID(), method = 'POST') {
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
  const config = { pool: db.pool, routeKey, access: real.access({ actions: actionCatalogue(kernel) }) };
  const meaning: PublicFacetMeaning = { digest, release, type: 'schema:Book' };
  return { db, real, accounts, config, meaning, create, propose, post, call, close: () => db.close() };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const home = (subject: string) => partitionOf(routeOf(subject)!);

export async function head(source: PublicFilterSource, partition: number): Promise<PrivacyHead> {
  const page = await source.readPrivacyHeads([partition]);
  expect(page.status).toBe('observed');
  if (page.status !== 'observed') throw new Error(`Native privacy heads ${page.status}`);
  expect(page.heads.map((entry) => entry.partition)).toEqual([partition]);
  return page.heads[0]!;
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
  frontier: PublicFacetFrontier | null = null,
) {
  const records: PublicFacetRecord[] = [];
  let steps = 0;
  let inputKeys = 0;
  for (;;) {
    const page = await capturedStep(f.db, () =>
      source.pagePublicFacets({ subject, meaning: f.meaning, inputLimit: 16, frontier }),
    );
    expect(['progress', 'complete']).toContain(page.status);
    if (page.status !== 'progress' && page.status !== 'complete') throw new Error(`Native projection ${page.status}`);
    expect(page.cost.inputKeys).toBeLessThanOrEqual(16);
    inputKeys += page.cost.inputKeys;
    records.push(...page.records);
    expect(++steps, 'Finite quiescent input must not restart at zero forever').toBeLessThan(10000);
    if (page.status === 'complete') return { records, page, steps, inputKeys };
    expect(page.frontier).not.toEqual(frontier);
    frontier = JSON.parse(
      JSON.stringify(page.frontier, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
    );
    // Preserve the lossless native bigint across a process-style retained frontier reload.
    frontier = { ...frontier!, generation: BigInt(frontier!.generation) };
  }
}

/** Search has not published a native preparation/ACK seam; no guessed factory or fake sink is accepted. */
export function missingSearchDependency(scenario: string): never {
  throw new Error(
    `Missing Search native producer/consumer dependency: ${scenario}. Requires real admitted plan execution, refresh-visible local and foreign repair ACK, and pre-disclosure head revalidation; no current export proves this.`,
  );
}
