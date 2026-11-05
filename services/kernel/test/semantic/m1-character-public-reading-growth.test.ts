import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { linkProjection, listSubjectLinks } from '../../src/semantic/links.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  captureUnforcedIndexes,
  logGrowthSeeding,
  seedSemanticPopulation,
  unrelatedSemanticPopulation,
} from './planner-fixtures.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const route = 15000;
const character = newId(route);
const performer = newId(route);
const holder = newId(route + 16);
const works = Array.from({ length: 12 }, (_, index) => newId(route + 16 + index));
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(84)]]) };
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'character-public-reading-growth',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};

beforeAll(async () => {
  db = await openGrowthDatabase(url);
  const digest = await bootstrapRelease(db.pool, bundledRelease);
  const create = async (
    id: string,
    at: number,
    type: string,
    label: string,
    statements?: Record<string, unknown[]>,
  ) => {
    await createSubject(db.pool, {
      actor,
      target: { route: at, id },
      idempotencyKey: id,
      digest: new Uint8Array(32),
      item: { type, labels: { en: label }, ...(statements ? { statements } : {}) },
      release: { digest, release: bundledRelease },
      authorize: async () => true,
    });
  };
  await create(character, route, 'wd:Q95074', 'Growth Character');
  await create(performer, route, 'schema:Person', 'Growth Performer');
  for (const [index, work] of works.entries())
    await create(work, route + 16 + index, 'schema:Movie', `A Work ${String(index).padStart(2, '0')}`, {
      'wdt:P725': [
        {
          property: { id: 'wdt:P725' },
          value: { type: 'value', content: performer },
          qualifiers: [{ property: { id: 'wdt:P453' }, value: { type: 'value', content: character } }],
        },
      ],
    });
  const projection = linkProjection(db.pool);
  const sourcePartitions = new Set(works.map((work) => partitionOf(routeOf(work)!)));
  for (const sourcePartition of sourcePartitions) {
    for (let step = 0; step < 20; step++) {
      const result = await projection.run(sourcePartition);
      if (result.status !== 'busy' && result.envelopes === 0) break;
      if (step === 19) throw new Error('Character voice projection did not catch up');
    }
  }
});

afterAll(async () => {
  await db.close();
});

test('qualified Character lookup bounds stale projection work as degree and history grow', async () => {
  const unrelated = unrelatedSemanticPopulation('character-public-reading-unrelated', route >>> 4);
  const page = async () => {
    const result = await listSubjectLinks(db.pool, ring, {
      routeKey: new Uint8Array(32).fill(1),
      subject: character,
      property: 'wdt:P725',
      filter: character,
      qualifier: { property: 'wdt:P453', value: character },
      limit: 12,
      includeLabels: true,
      release: bundledRelease,
      releasePin: bundledDigest,
      authorizeSummary: async () => true,
      seen: [],
      caughtUp: true,
      authorize: async () => true,
    });
    expect(result.links).toHaveLength(12);
    expect(result.links.map((link) => link.subject).sort()).toEqual([...works].sort());
    for (const link of result.links) {
      expect(link.assertion?.property.id).toBe('wdt:P725');
      expect(link.assertion?.value).toEqual({ type: 'value', content: performer });
      expect(link.creditSlot).toEqual({ property: 'wdt:P725', target: performer, key: character });
    }
    expect(result.partial).toBe(true);
    expect(result.next).not.toBeNull();
  };
  const report = await checkGrowth(db, {
    name: 'Character qualified stale projection page',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (_database: GrowthDatabase, scale: number, previous: number) => {
      await seedSemanticPopulation(db, unrelated.population, { from: previous, to: scale });
      await db.admin.query(
        `WITH cursor AS (
           SELECT repeat('z', 300) AS order_key
         )
         INSERT INTO semantic.inbound_link
          (route,subject_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key,filter_value)
         SELECT $1,$2,'wdt:P725',$3,gen_random_uuid(),1,true,gen_random_uuid(),'schema:Movie',cursor.order_key || lpad(n::text,8,'0'),$4
         FROM cursor CROSS JOIN generate_series($5::int,$6::int) n`,
        [route, character, holder, character, previous, scale - 1],
      );
    },
    prepare: async (_database, scale) => {
      await captureUnforcedIndexes(db, 'Character qualified stale projection page', scale, page, {
        'semantic.subject': 'subject_pkey',
        'semantic.fact': 'fact_pkey',
        'semantic.outbound_link': 'outbound_link_present',
        'semantic.inbound_link': 'inbound_link_present',
      });
    },
    operation: page,
  });
  logGrowthSeeding(report);
  expect(report.samples).toHaveLength(3);
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 180_000);
