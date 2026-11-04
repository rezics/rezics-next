import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { createPool } from '../../src/database/pool.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accounts = { curator: newId(0) };
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    root: { props: {} },
    content: [
      { type: 'SubjectHeader', props: { id: 'header' } },
      { type: 'Heading', props: { id: 'supported', level: 2, text: { en: 'Captured public page' } } },
    ],
  },
  bases: [],
  types: [],
  routes: [],
};
let db: GrowthDatabase;
let pool: ReturnType<typeof createPool>;
let admin: pg.Pool;
let kernel: ReturnType<typeof createKernel>;
let bearer: string;
let subject: string;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  pool = createPool(db.url);
  admin = new pg.Pool({ connectionString: db.url, max: 2 });
  await bootstrapRelease(pool, bundledRelease);
  await admin.query(
    `INSERT INTO semantic.context (route,context_id,kind,labels,defaults,recorded_transaction_id)
    VALUES (0,$1,'global','{"en":"Global"}','{}',$2) ON CONFLICT DO NOTHING`,
    [GLOBAL_CONTEXT, randomUUID()],
  );
  const access = await createRealAccess(admin, accounts, [
    'presentation:read',
    'presentation:publish',
    'subject:create',
  ]);
  for (const action of ['presentation:read', 'presentation:publish', 'subject:create'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
  kernel = createKernel({
    pool,
    access: access.access,
    writeRate: access.writeRate,
    routeKey: new Uint8Array(32).fill(6),
    requestDeadlineMs: 30_000,
  });
  bearer = `Bearer ${access.bearer('curator')}`;
  const created = await kernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: bearer,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Captured preview anchor' } }),
    }),
  );
  const answer = (await created.json()) as any;
  expect(created.status, JSON.stringify(answer)).toBe(201);
  subject = answer.subject.id as string;
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.close();
});

test('native captured preview keeps public admission and wire cost bounded at 256, 1024 and 4096 unrelated subjects', async () => {
  const population: Population = {
    name: 'captured-preview-unrelated-subjects',
    hotPartition: partitionOf(routeOf(subject)!),
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const transactionId = randomUUID();
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: transactionId }],
        'semantic.revision': [
          {
            route,
            subject_id: id,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transactionId,
          },
        ],
        'semantic.fact': itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } }).map((fact) => ({
          ...fact,
          route,
          subject_id: id,
          recorded_transaction_id: transactionId,
        })),
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'native captured preview keeps public admission and wire cost bounded at 256, 1024 and 4096 unrelated subjects',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: (database, scale, previous) =>
      seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale }),
    operation: async () => {
      const response = await kernel.handle(
        new Request('http://kernel.test/v1/pages:previewDraft', {
          method: 'POST',
          headers: {
            authorization: bearer,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ profile, target: { subject }, languages: ['en'] }),
        }),
      );
      const body = (await response.json()) as { document?: unknown; subject?: string };
      if (response.status !== 200) throw new Error(`captured preview status ${response.status}`);
      if (body.subject !== subject) throw new Error('captured preview lost its subject identity');
      return body;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.requestBytes!).toBeGreaterThan(0);
    expect(cost.responseBytes!).toBeGreaterThan(0);
  }
}, 180_000);
