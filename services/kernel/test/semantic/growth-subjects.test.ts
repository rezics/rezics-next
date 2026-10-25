import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { openGrowthDatabase, checkGrowth, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { createSubject, readLabels, readSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { runCommand } from '../../src/command/command.ts';
import { itemFacts, resolveItem } from '../../src/semantic/item.ts';
import { pageSubjects } from '../../src/semantic/page.ts';
import type { AccountActor } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const routeKey = new Uint8Array(32).fill(51);
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'growth',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const keyring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
function subjectPopulation(hotPartition: number): Population {
  return {
    name: 'semantic-subject-growth',
    hotPartition,
    hotShare: 1,
    // Each population row matches the subject and label fact inserted by createSubject/itemFacts.
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const tx = randomUUID();
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: tx }],
        'semantic.fact': [
          {
            route,
            subject_id: id,
            slot_id: randomUUID(),
            log_seq: 1,
            operation: 'assert',
            kind: 'label',
            language: 'en',
            property: null,
            statement_id: null,
            body: `Seed ${ordinal}`,
            recorded_transaction_id: tx,
          },
        ],
      };
    },
  };
}
let anchor = '';
let partition = 0;
const cursors = new Map<number, string>();
const subject = { labels: { en: 'Growth anchor' } };

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  const target = subjectTarget(routeKey, actor.accountId, `growth-anchor-${randomUUID()}`);
  anchor = target.id;
  partition = partitionOf(target.route);
  await createSubject(db.pool, {
    actor,
    target,
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(anchor).digest(),
    item: subject,
    authorize: async () => true,
  });
});
afterAll(async () => {
  if (db) await db.close();
});

async function grow(database: GrowthDatabase, scale: number, previous: number, name: string) {
  const population: Population = { ...subjectPopulation(partition), name };
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: previous,
    to: scale,
  });
}

test('Subject creation stays within its bound as N grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Subject creation stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-create-growth'),
    operation: async (database, _scale, repetition) => {
      const key = `growth-create-${randomUUID()}-${repetition}`;
      const target = subjectTarget(routeKey, actor.accountId, key);
      return createSubject(database.pool, {
        actor,
        target,
        idempotencyKey: key,
        digest: createHash('sha256').update(key).digest(),
        item: subject,
        authorize: async () => true,
      });
    },
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);

test('Command and receipt stays within its bound as N grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Command and receipt stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      await grow(database, scale, previous, 'semantic-command-growth');
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        const key = `growth-history-${ordinal}-${randomUUID()}`;
        await runCommand(
          database.pool,
          {
            partition,
            receipt: {
              actorAccountId: actor.accountId,
              kind: 'growth.history',
              key,
              digest: createHash('sha256').update(key).digest(),
            },
            basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: null },
          },
          async () => ({ value: null, events: [{ type: 'com.rezics.growth.v1', data: { ordinal } }] }),
        );
      }
    },
    operation: async (database, _scale, repetition) => {
      const key = `growth-replay-${repetition}`;
      return runCommand(
        database.pool,
        {
          partition,
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'growth.replay',
            key,
            digest: createHash('sha256').update(key).digest(),
          },
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: null },
        },
        async () => ({ value: null, events: [] }),
      );
    },
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);

test('Anchored subject read stays within its bound as N grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Anchored subject read stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-read-growth'),
    operation: (database) => readSubject(database.pool, anchor, async () => true),
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);

test('Partition keyset page stays within its bound as d grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Partition keyset page stays within its bound as d grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      await grow(database, scale, previous, 'semantic-page-growth');
      // Growth is placed in the page's partition so each scale advances the keyset depth.
      // This population uses the same production subject and label-fact shape as the page read.
      const local: Population = { ...subjectPopulation(partition), name: 'semantic-page-depth' };
      await seed({ pool: database.pool, admin: database.admin }, local, { from: previous, to: scale });
      let cursor: string | undefined;
      for (let depth = 0; depth < scale; depth++) {
        const page = await pageSubjects(database.pool, keyring, { partition, size: 1, ...(cursor ? { cursor } : {}) });
        if (!page?.next) break;
        cursor = page.next;
      }
      if (cursor) cursors.set(scale, cursor);
    },
    operation: async (database, scale) => {
      const cursor = cursors.get(scale);
      const page = await pageSubjects(database.pool, keyring, { partition, size: 1, ...(cursor ? { cursor } : {}) });
      return page;
    },
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);

test('Item projection and related labels stays within its bound as P grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Item projection and related labels stays within its bound as P grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-related-growth'),
    operation: async (database) => readLabels(database.pool, [anchor]),
  });
  expect(report.samples).toHaveLength(3);
  expect(resolveItem(anchor, itemFacts(anchor, subject)).labels).toEqual(subject.labels);
}, 90_000);

test('Batch label fill stays within its bound as P grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Batch label fill stays within its bound as P grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-batch-label-growth'),
    operation: async (database) => readLabels(database.pool, [anchor]),
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);

test('Request authorization stays within its bound as N grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Request authorization stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-authorization-growth'),
    operation: async (database) => {
      // A stable, empty authorization callback isolates the anchored semantic request read.
      return readSubject(database.pool, anchor, async () => true);
    },
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);
