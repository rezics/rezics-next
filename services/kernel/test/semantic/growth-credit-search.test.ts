import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { CREDIT_SEARCH_LIMITS, type CreditSearchPage } from '../../src/search/credit-search.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import {
  createCreditSearchSource,
  receiveCreditSearch,
  receiveCreditSearchMatch,
} from '../../src/semantic/credit-search.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const BASE_ROUTE = 701 * 16;
const UNRELATED_PARTITION = 702;
let db: GrowthDatabase;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = newId(BASE_ROUTE);
const routeKey = new Uint8Array(32).fill(93);
let adapter: ReturnType<typeof createCreditSearchSource>;
let workId: string;
let observation: string;
let matchedName: Parameters<typeof receiveCreditSearchMatch>[2];

async function create(type: string, label: string, extra?: Record<string, unknown>) {
  const kernel = createKernel({
    pool: db.pool,
    access: real.access,
    writeRate: real.writeRate,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) },
    routeKey,
    receiptKeys: testReceiptKeys(),
  });
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${real.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      body: JSON.stringify({ type, labels: { en: label }, ...extra }),
    }),
  );
  const body = (await response.json()) as { subject?: { id: string } };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.subject!.id;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
  real = await createRealAccess(db.admin, { editor }, ['subject:create', 'subject:read']);
  for (const action of ['subject:create', 'subject:read'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  adapter = createCreditSearchSource(db.pool, routeKey);
  const author = await create('schema:Person', 'Anchored writer', {
    aliases: { en: ['Pen name'], ja: ['著者'] },
  });
  const actor = await create('schema:Person', 'Anchored voice');
  const vn = await create('wd:Q689445', 'Anchored visual novel', {
    statements: {
      'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: author } }],
    },
  });
  await create('schema:TVSeries', 'Anchored anime', {
    statements: {
      'wdt:P725': [{ property: { id: 'wdt:P725' }, value: { type: 'value', content: actor } }],
    },
  });
  workId = vn;
  const projection = await receiveCreditSearch(adapter, workId);
  expect(projection.state).toBe('complete');
  if (projection.state !== 'complete') throw new Error('anchored complete projection');
  observation = projection.observation;
  matchedName = projection.names[0]!;
  expect(projection.names.some((name) => name.name.value === 'Pen name')).toBe(true);
}, 120_000);
afterAll(async () => {
  await db?.close();
});

test('anchored credit-search seeks stay constant as unrelated catalogue grows', async () => {
  const report = await checkGrowth(db, {
    name: 'credit-search-anchored-native-seeks',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => {
        const page = value as CreditSearchPage;
        return {
          credits: page.state === 'current' ? page.entries.length : 0,
          names: page.state === 'current' ? page.entries.reduce((count, entry) => count + entry.names.length, 0) : 0,
          identity: page.state === 'current' ? new Set(page.entries.map((entry) => entry.witness.targetId)).size : 0,
        };
      },
      limits: {
        credits: CREDIT_SEARCH_LIMITS.creditsPerPage,
        names: CREDIT_SEARCH_LIMITS.namesPerCreator,
        identity: 32,
      },
      bounds: { credits: 'constant', names: 'constant', identity: 'constant' },
    },
    grow: async (_, scale, previous) => {
      await seed(
        { pool: db.pool, admin: db.admin },
        {
          name: 'unrelated-credit-search-population',
          hotPartition: UNRELATED_PARTITION,
          hotShare: 1,
          rows({ route, ordinal }) {
            const id = newId(route);
            const transaction = randomUUID();
            const facts = itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } });
            return {
              'semantic.subject': [
                {
                  route,
                  subject_id: id,
                  type: ordinal % 2 === 0 ? 'schema:Person' : 'schema:Book',
                  recorded_transaction_id: transaction,
                  visibility: 'visible',
                  security_revision: 0,
                  current_facts: facts.length,
                  current_release: bundledDigest,
                },
              ],
              'semantic.fact': facts.map((fact) => ({
                ...fact,
                route,
                subject_id: id,
                recorded_transaction_id: transaction,
                release: null,
              })),
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    operation: async () => {
      const page = await adapter.page({
        workId,
        after: null,
        observation: null,
        limits: CREDIT_SEARCH_LIMITS,
      });
      expect(page.state).toBe('current');
      if (page.state !== 'current') throw new Error('current page');
      expect(page.entries.length).toBeGreaterThan(0);
      expect(await adapter.unchanged(workId, page.observation)).toBe(true);
      expect(
        await receiveCreditSearchMatch(
          adapter,
          {
            state: 'complete',
            workId,
            observation: page.observation,
            names: page.entries.flatMap((entry) => entry.names.map((name) => ({ ...entry.witness, name }))),
          },
          matchedName,
        ),
      ).toBe('current');
      return page;
    },
  });
  expect(report.samples).toHaveLength(3);
  expect(observation).toBeString();
  expect(partitionOf(routeOf(workId)!)).not.toBe(UNRELATED_PARTITION);
}, 180_000);
