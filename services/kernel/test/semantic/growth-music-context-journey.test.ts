import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { PUBLICATION_LIMITS, publicationLimits, RELEASE_LIMITS, validateRelease } from '@rezics/definitions';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { seedSemanticPopulation, unrelatedSemanticPopulation } from './planner-fixtures.ts';
import { verticalManifests } from '../support/manifests.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const NIL = '00000000-0000-0000-0000-000000000000';
const route = 16000;
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'growth',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
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
  const releaseDigest = await bootstrapRelease(db.pool, bundledRelease);
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
    routeKey: new Uint8Array(32).fill(61),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(62)]]) },
  });
  const created = await createSubject(db.pool, {
    actor,
    target: { route, id: newId(route) },
    idempotencyKey: randomUUID(),
    digest: new Uint8Array(32),
    item: { type: 'schema:MusicEvent', labels: { en: 'Selected concert' } },
    release: { digest: releaseDigest, release: bundledRelease },
    authorize: async () => true,
  });
  eventId = created.subject.id;
  await db.admin.query(
    `INSERT INTO semantic.outbound_link(
       route, subject_id, property, filter_value, order_key, target_subject_id, statement_id, slot_id,
       relation, source_type, source_order_key, outbound_order, source_revision, source_security_revision,
       target_revision, target_type, external, value, present, recorded_transaction_id)
     SELECT $1, $2, 'schema:location', $3, lpad(n::text, 8, '0'), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            true, 'schema:MusicEvent', lpad(n::text, 8, '0'), 'name', 1, 0, 1, 'schema:MusicVenue', NULL, 'value', true, gen_random_uuid()
     FROM generate_series(1, 20) n`,
    [route, eventId, NIL],
  );
  await db.admin.query(
    `INSERT INTO semantic.outbound_link_count(route, subject_id, property, filter_value, value)
     VALUES ($1, $2, 'schema:location', $3, 20)`,
    [route, eventId, NIL],
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
