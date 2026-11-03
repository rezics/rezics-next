import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const routeKey = new Uint8Array(32).fill(7);
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  clientId: 'web',
  scopes: ['subject:create', 'subject:read', 'presentation:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const ordinalsPerScale = 1_000;
const scales = [1, 4, 16] as const;

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({
  type,
  props: { id, ...props },
});
const document = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: document(node('Heading', 'home', { text: 'Home', level: 2 })),
  bases: [],
  types: [
    {
      type: 'schema:Book',
      document: document(
        node('SubjectHeader', 'header'),
        node('Statements', 'facts', { properties: ['schema:author'] }),
        node('Statements', 'more', { properties: ['schema:publisher'] }),
      ),
    },
  ],
  routes: [],
};

function subjectPopulation(hotPartition: number): Population {
  return {
    name: 'page-read-subjects',
    hotPartition,
    hotShare: 1,
    // One stored subject, its create revision, and its label fact. The measured page reads a different subject.
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const tx = randomUUID();
      const facts = itemFacts(id, { labels: { en: `Seed ${ordinal}` } });
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: tx }],
        'semantic.revision': [
          {
            route,
            subject_id: id,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: tx,
          },
        ],
        'semantic.fact': facts.map((fact) => ({ ...fact, route, subject_id: id, recorded_transaction_id: tx })),
      };
    },
  };
}

let db: GrowthDatabase;
let anchor = '';
let kernel: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  configureTestReceiptKeys(db.pool);
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, profile);
  const target = subjectTarget(routeKey, actor.accountId, `page-anchor-${randomUUID()}`);
  anchor = target.id;
  await createSubject(db.pool, {
    actor,
    target,
    idempotencyKey: randomUUID(),
    digest: new Uint8Array(32).fill(9),
    item: { type: 'schema:Book', labels: { en: 'Page anchor' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  kernel = createKernel({
    pool: db.pool,
    receiptKeys: testReceiptKeys(),
    requestDeadlineMs: 30_000,
    routeKey,
    access: {
      async authenticate() {
        return actor;
      },
      async authorize() {
        return true;
      },
    },
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
});

afterAll(async () => {
  await db?.close();
});

test('Page read stays within its bound as N grows', async () => {
  const population = subjectPopulation(partitionOf(routeOf(anchor)!));
  const report = await checkGrowth(db, {
    name: 'Page read stays within its bound as N grows',
    scales,
    bounds,
    grow: (database, scale, previous) =>
      seed({ pool: database.pool, admin: database.admin }, population, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      }),
    operation: async () => {
      const response = await kernel.handle(
        new Request('http://kernel.test/v1/pages:read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: { subject: anchor } }),
        }),
      );
      const body = (await response.json()) as { template?: { scope: string; key: string } };
      if (response.status !== 200) throw new Error(`page read status ${response.status}`);
      if (body.template?.scope !== 'type' || body.template.key !== 'schema:Book')
        throw new Error('page read did not resolve the type template');
      return body;
    },
  });
  expect(report.samples).toHaveLength(3);
}, 180_000);
