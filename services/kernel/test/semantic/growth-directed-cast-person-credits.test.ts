import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const BASE_ROUTE = 619 * 16;
const UNRELATED_PARTITION = 620;
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = newId(BASE_ROUTE);
let actor: string;
let character: string;

async function call(path: string) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, { headers: { authorization: `Bearer ${real.bearer('editor')}` } }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

async function create(type: string, label: string, statements?: Record<string, unknown[]>) {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${real.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      body: JSON.stringify({ type, labels: { en: label }, ...(statements ? { statements } : {}) }),
    }),
  );
  const body = (await response.json()) as any;
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.subject.id as string;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
  real = await createRealAccess(db.admin, { editor }, ['subject:create', 'subject:read']);
  for (const action of ['subject:create', 'subject:read'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  kernel = createKernel({
    pool: db.pool,
    access: real.access,
    writeRate: real.writeRate,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(73)]]) },
    routeKey: new Uint8Array(32).fill(74),
    receiptKeys: testReceiptKeys(),
  });
  actor = await create('schema:Person', 'Fixed voice actor');
  character = await create('wd:Q95074', 'Fixed character');
  const work = await create('schema:Movie', 'Fixed voice work', {
    'wdt:P725': [
      {
        property: { id: 'wdt:P725' },
        value: { type: 'value', content: actor },
        qualifiers: [
          { property: { id: 'wdt:P453' }, value: { type: 'value', content: character } },
          { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Original name' } },
        ],
      },
    ],
  });
  // Materialize the fixed native fixture before measuring reads; obsolete rows remain in the measured partition.
  expect((await linkProjection(db.pool).run(partitionOf(routeOf(work)!))).status).not.toBe('busy');
}, 120_000);
afterAll(async () => {
  await db?.close();
});

test('one inverse cast window stays fixed across unrelated catalogue growth and obsolete edge history', async () => {
  const report = await checkGrowth(db, {
    name: 'directed-cast-person-credit-window',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (_, scale, previous) => {
      await seed(
        { pool: db.pool, admin: db.admin },
        {
          name: 'unrelated-people-works-and-obsolete-cast-edges',
          hotPartition: UNRELATED_PARTITION,
          hotShare: 1,
          rows({ route, ordinal }) {
            const id = newId(route);
            const transaction = randomUUID();
            return {
              'semantic.subject': [
                {
                  route,
                  subject_id: id,
                  type: ordinal % 2 === 0 ? 'schema:Person' : 'schema:Movie',
                  recorded_transaction_id: transaction,
                  current_facts: 1,
                  current_release: bundledDigest,
                },
              ],
              'semantic.revision': [
                {
                  route,
                  subject_id: id,
                  revision: 1,
                  kind: 'create',
                  release: bundledDigest,
                  recorded_transaction_id: transaction,
                },
              ],
              'semantic.inbound_link': [
                {
                  route: routeOf(actor)!,
                  subject_id: actor,
                  property: 'wdt:P725',
                  filter_value: '00000000-0000-0000-0000-000000000000',
                  context_id: GLOBAL_CONTEXT,
                  source_subject_id: id,
                  statement_id: randomUUID(),
                  source_revision: 1,
                  source_security_revision: 0,
                  source_type: 'schema:Movie',
                  order_key: labelOrderKey({ en: `Obsolete ${ordinal}` }),
                  present: false,
                  recorded_transaction_id: transaction,
                },
              ],
            };
          },
        },
        { from: previous + 1, to: scale },
      );
    },
    operation: async () => {
      const page = await call(`/v1/subjects/${actor}/links?property=wdt%3AP725&limit=20`);
      expect(page.status).toBe(200);
      expect(page.body.links).toHaveLength(1);
      expect(page.body.links[0].assertion.qualifiers.map((item: any) => item.property.id)).toEqual([
        'wdt:P453',
        'wdt:P1932',
      ]);
      const row = page.body.links[0];
      expect(row.creditSlot).toEqual({ property: 'wdt:P725', target: actor, key: character });
      const detail = await call(`/v1/subjects/${row.subject}/revisions/${row.assertion.rezics.revision}`);
      expect(detail.status).toBe(200);
      expect(detail.body.subject).toBe(row.subject);
      expect(detail.body.revision.revision).toBe(row.assertion.rezics.revision);
      return { rows: page.body.links.length, next: page.body.next, property: page.body.links[0].property };
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
}, 300_000);
