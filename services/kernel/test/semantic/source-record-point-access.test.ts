import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import readGlobalContext from '../../src/semantic/context-read-global.sql';
import { readSourceRecords, validateSourceRecordMetadata } from '../../src/semantic/source-records.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
} from '../support/growth.ts';
import {
  attributionFixture,
  registeredBangumi,
  routeKey,
  source,
  status,
  type AttributionFixture,
} from './support/source-record-attribution.ts';

let db: GrowthDatabase;
let f: AttributionFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await attributionFixture(db, db.openPool({ max: 1 }));
});
afterAll(async () => {
  await db?.close();
});

test('native tuple hydration and Global anchors use bounded physical points at every attribution scale', async () => {
  const origins = [source(), source()];
  const records = await Promise.all(origins.map((origin) => f.filled(origin)));
  const missing = source();
  // All legal payload and identity limits must survive the physical access design.
  const maximumOrigin = source('字'.repeat(255), 'a'.repeat(32));
  const maximumRecord = {
    name: '字'.repeat(255),
    url: `https://example.test/${'字'.repeat(2027)}`,
    licence: { id: `LicenseRef-${'a'.repeat(117)}`, url: `https://example.test/${'字'.repeat(2027)}` },
    attribution: '字'.repeat(500),
  };
  const command = {
    source: maximumOrigin.source,
    external_id: maximumOrigin.external_id,
    metadata: maximumRecord,
    expected_metadata_revision: null,
  };
  validateSourceRecordMetadata(command);
  status(await f.metadata(maximumOrigin, maximumRecord), 201);
  expect(await readSourceRecords(f.pool, routeKey, [maximumOrigin])).toEqual([maximumRecord]);

  const report = await checkGrowth(db, {
    name: 'source-record-point-access',
    scales: [64, 512, 4096],
    rule: 'series',
    repetitions: 5,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (_, scale, previous) => {
      await seed(
        { pool: db.pool, admin: db.admin },
        {
          name: 'source-record-point-access',
          hotPartition: 0,
          hotShare: 0.5,
          rows({ ordinal }) {
            const origin = source(`unrelated-${ordinal}`);
            return {
              'semantic.context': [
                {
                  route: 0,
                  context_id: newId(0),
                  kind: 'community',
                  labels: { en: `Unrelated Context ${ordinal}` },
                  recorded_transaction_id: randomUUID(),
                },
              ],
              'semantic.source_record': [
                {
                  route: tupleRoute(routeKey, origin.source, origin.external_id),
                  source: origin.source,
                  external_id: origin.external_id,
                  metadata_revision: 1,
                  record: registeredBangumi(origin.external_id),
                  recorded_transaction_id: randomUUID(),
                },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    operation: async () => {
      expect(await readSourceRecords(f.pool, routeKey, [...origins, missing])).toEqual(records);
      const client = await f.pool.connect();
      try {
        expect(await readGlobalContext.run(client, { route: 0, context_id: GLOBAL_CONTEXT })).not.toBeNull();
        expect(await readGlobalContext.run(client, { route: 0, context_id: newId(0) })).toBeNull();
      } finally {
        client.release();
      }
    },
  });
  console.info(`SOURCE_RECORD_POINT_SAMPLES ${JSON.stringify(report.samples)}`);
  assertGrowthAccessPaths('source-record-point-access', report.samples, ['semantic.source_record', 'semantic.context']);
  for (const sample of report.samples) {
    for (const cost of sample.repetitions) {
      // Tiny relations retain all physical work in the inclusive growth series.
      // Exact point-row bounds apply once the measured relation exceeds eight pages.
      const metadata = sample.relationSizes['semantic.source_record'];
      const context = sample.relationSizes['semantic.context'];
      expect(metadata).toBeDefined();
      expect(context).toBeDefined();
      if (metadata!.relpages > 8)
        expect(cost.relations['semantic.source_record']?.rows, `metadata at ${sample.scale}`).toBe(2);
      if (context!.relpages > 8) expect(cost.relations['semantic.context']?.rows, `Global at ${sample.scale}`).toBe(1);
    }
  }
}, 120_000);
