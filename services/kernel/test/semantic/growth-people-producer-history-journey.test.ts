import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest, validateRelease } from '@rezics/definitions';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { verticalManifests, verticalProfile } from '../support/manifests.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const BASE_ROUTE = 619 * 16;
const UNRELATED_PARTITION = 620;
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = newId(BASE_ROUTE);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(83)]]) };
const routeKey = new Uint8Array(32).fill(84);
let personId: string;
let studioId: string;

async function call(path: string, asEditor = true) {
  const headers: Record<string, string> = {};
  if (asEditor) headers.authorization = `Bearer ${real.bearer('editor')}`;
  const response = await kernel.handle(new Request(`http://kernel.test${path}`, { headers }));
  return { status: response.status, body: (await response.json()) as any };
}

async function create(type: string, name: string) {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${real.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      body: JSON.stringify({ type, labels: { en: name } }),
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
    tokens,
    routeKey,
    receiptKeys: testReceiptKeys(),
  });
  personId = await create('schema:Person', 'Fixed biography subject');
  studioId = await create('schema:Organization', 'Fixed producer subject');
}, 120_000);
afterAll(async () => {
  await db?.close();
});

test('fixed biography and first producer window stay bounded as unrelated people facts and history grow', async () => {
  const report = await checkGrowth(db, {
    name: 'people-producer-history-window',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (_, scale, previous) => {
      await seed(
        { pool: db.pool, admin: db.admin },
        {
          name: 'unrelated-people-facts-history',
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
                  type: ordinal % 2 === 0 ? 'schema:Person' : 'schema:Organization',
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
            };
          },
        },
        { from: previous + 1, to: scale },
      );
    },
    operation: async () => {
      const person = await call(`/v1/subjects/${personId}`);
      expect(person.status).toBe(200);
      expect(person.body.subject.id).toBe(personId);
      const window = await call(
        `/v1/subjects/${studioId}/relations?property=${encodeURIComponent('wdt:P749')}&limit=20`,
      );
      expect(window.status).toBe(200);
      expect(window.body.relations).toEqual([]);
      return { person: person.body.subject.id, rows: window.body.relations.length };
    },
  });
  expect(partitionOf(routeOf(personId)!)).not.toBe(UNRELATED_PARTITION);
  expect(report.samples).toHaveLength(3);
}, 300_000);

test('ten and one hundred manifests keep admitted biography and producer properties without a new compiler', async () => {
  for (const count of [10, 100]) {
    const extra = verticalManifests(count);
    const base = bundledSources();
    const root = Bun.YAML.parse(base.schemas['rezics.yaml']!) as { imports: string[] };
    root.imports = [...root.imports, ...Array.from({ length: count }, (_, index) => verticalProfile(index).name)];
    const release = await compileCatalogue({
      ...base,
      schemas: { ...base.schemas, 'rezics.yaml': Bun.YAML.stringify(root), ...extra.schemas },
      presentation: { ...base.presentation, ...extra.presentation },
    });
    expect(validateRelease(release)).toEqual([]);
    expect(release.types['schema:Person']!.properties).toEqual(
      expect.arrayContaining(['schema:abstract', 'wdt:P106', 'schema:knowsLanguage']),
    );
    expect(release.types['schema:Organization']!.properties).toEqual(
      expect.arrayContaining(['schema:abstract', 'wdt:P749', 'wdt:P1365', 'wdt:P1366']),
    );
    expect(Object.keys(release.types)).toHaveLength(Object.keys(bundledRelease.types).length + count * 3);
    expect(Object.keys(release.properties)).toHaveLength(Object.keys(bundledRelease.properties).length + count * 12);
    expect(releaseDigest(release)).not.toBe(bundledDigest);
  }
  expect(releaseDigest(bundledRelease)).toBe(bundledDigest);
  expect(bundledRelease.catalogue.version).toBe('1.0.2');
}, 120_000);
