import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { PUBLICATION_LIMITS, publicationLimits, RELEASE_LIMITS, validateRelease } from '@rezics/definitions';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { seedSemanticPopulation, unrelatedSemanticPopulation } from './planner-fixtures.ts';
import { verticalManifests } from '../support/manifests.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const NIL = '00000000-0000-0000-0000-000000000000';
const route = 16000;
const node = (type: string, id: string) => ({ type, props: { id } });
const document = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let eventId: string;
let digest: string;

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeAll(async () => {
  db = await openGrowthDatabase(url);
  configureTestReceiptKeys(db.pool);
  await bootstrapRelease(db.pool, bundledRelease);
  const profile: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: document(node('SubjectHeader', 'header')),
    bases: [],
    types: [],
    routes: [],
  };
  await bootstrapProfile(db.pool, profile);
  digest = profileDigest(profile);
  kernel = createKernel({
    pool: db.pool,
    receiptKeys: testReceiptKeys(),
    requestDeadlineMs: 30_000,
    routeKey: new Uint8Array(32).fill(61),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(62)]]) },
  });
  const selected: { id: string; route: number } = { id: '', route: 0 };
  await seed(
    db,
    {
      name: 'music-context-selected-event',
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows: ({ route: placed }) => {
        const id = newId(placed);
        selected.id = id;
        selected.route = placed;
        const transaction = randomUUID();
        const facts = itemFacts(id, { labels: { en: 'Selected concert' } }, 'schema:MusicEvent', bundledRelease);
        return {
          'semantic.subject': [
            {
              route: placed,
              subject_id: id,
              type: 'schema:MusicEvent',
              recorded_transaction_id: transaction,
              visibility: 'visible',
              security_revision: 0,
              current_facts: facts.length,
              current_release: bundledDigest,
              projection_pending: false,
            },
          ],
          'semantic.revision': [
            {
              route: placed,
              subject_id: id,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          'semantic.fact': facts.map((fact) => ({
            ...fact,
            route: placed,
            subject_id: id,
            recorded_transaction_id: transaction,
            release: fact.kind === 'statement' ? bundledDigest : null,
            relation: false,
          })),
        };
      },
    },
    { from: 0, to: 1 },
  );
  eventId = selected.id;
  await db.admin.query(
    `INSERT INTO semantic.outbound_link(
       route, subject_id, property, filter_value, order_key, target_subject_id, statement_id, slot_id,
       relation, source_type, source_order_key, outbound_order, source_revision, source_security_revision,
       target_revision, target_type, external, value, present, recorded_transaction_id)
     SELECT $1, $2, 'schema:location', $3, lpad(n::text, 8, '0'), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            true, 'schema:MusicEvent', lpad(n::text, 8, '0'), 'name', 1, 0, 1, 'schema:MusicVenue', NULL, 'value', true, gen_random_uuid()
     FROM generate_series(1, 20) n`,
    [selected.route, eventId, NIL],
  );
  await db.admin.query(
    `INSERT INTO semantic.outbound_link_count(route, subject_id, property, filter_value, value)
     VALUES ($1, $2, 'schema:location', $3, 20)`,
    [selected.route, eventId, NIL],
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('a selected music-event window stays fixed at 64/512/4096 unrelated events places and credits', async () => {
  const unrelated = unrelatedSemanticPopulation('music-context-unrelated', (route >> 4) + 3);
  const report = await checkGrowth(db, {
    name: 'Music context selected window',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (_database, scale, previous) => {
      await seedSemanticPopulation(db, unrelated.population, { from: previous * 500, to: scale * 500 });
    },
    operation: async () => {
      const page = await call('POST', '/v1/pages:read', { target: { subject: eventId } });
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.profile).toBe(digest);
      expect(page.body.subject).toBe(eventId);
      const window = await call(
        'GET',
        `/v1/subjects/${eventId}/relations?property=${encodeURIComponent('schema:location')}&limit=20`,
      );
      expect(window.status, JSON.stringify(window.body)).toBe(200);
      expect(window.body.relations).toHaveLength(20);
      expect(window.body.relations.every((row: { statement?: unknown }) => row.statement)).toBe(true);
      expect(window.body.next === null || typeof window.body.next === 'string').toBe(true);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  const recorded = report.samples.map(({ scale, cost }) => ({
    scale,
    rows: cost.rows,
    blocks: cost.blocks,
    statements: cost.statements,
    ...(cost.responseBytes === undefined ? {} : { bytes: cost.responseBytes }),
  }));
  console.info(`Music context native work ${JSON.stringify(recorded)}`);
  expect(recorded.every((sample) => sample.rows === recorded[0]!.rows && sample.rows > 0)).toBe(true);
  expect(recorded.every((sample) => sample.blocks === recorded[0]!.blocks)).toBe(true);
}, 180_000);

test('released definitions expand at 10/100 manifests without new engine branches', async () => {
  expect(PUBLICATION_LIMITS).toEqual({ bases: 4096, mappings: 256, qualifiers: 4096 });
  for (const count of [10, 100]) {
    const extra = verticalManifests(count);
    const bundled = bundledSources();
    const release = await compileCatalogue({
      ...bundled,
      schemas: {
        ...bundled.schemas,
        ...extra.schemas,
        'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${Array.from({ length: count }, (_, i) => `  - v${i}`).join('\n')}\n`,
      },
      presentation: { ...bundled.presentation, ...extra.presentation },
    });
    expect(validateRelease(release)).toEqual([]);
    expect(publicationLimits(release)).toEqual([]);
    expect(Object.keys(release.types)).toHaveLength(Object.keys(bundledRelease.types).length + count * 3);
    expect(release.types['schema:MusicEvent']).toEqual(bundledRelease.types['schema:MusicEvent']);
    expect(release.types['wd:Q34379']).toEqual(bundledRelease.types['wd:Q34379']);
    expect(Buffer.byteLength(JSON.stringify(release))).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
  }
}, 120_000);
