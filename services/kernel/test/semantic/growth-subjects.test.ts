import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { openGrowthDatabase, checkGrowth, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { createSubject, readLabels, readSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { runCommand } from '../../src/command/command.ts';
import { factDataTypes, itemFacts, resolveItem } from '../../src/semantic/item.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { pageSubjects } from '../../src/semantic/page.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { withConnection } from '../../src/database/pool.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const ordinalsPerScale = 250;
let db: GrowthDatabase;
const routeKey = new Uint8Array(32).fill(51);
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'growth',
  scopes: ['subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const keyring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
const itemType = 'schema:Book';
function projectSubject(id: string, facts: ReturnType<typeof itemFacts>) {
  return resolveItem(id, facts, itemType, factDataTypes(bundledRelease, facts), {
    revision: 1,
    release: bundledDigest,
    context: GLOBAL_CONTEXT,
  });
}
function subjectPopulation(hotPartition: number, name = 'semantic-subject-growth'): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    // Each population row matches createSubject/itemFacts plus the command's receipt, outbox, and write-basis rows.
    finish: async (admin, _range) => {
      await admin.query(
        `UPDATE core.partition
         SET position = GREATEST(position, COALESCE((
           SELECT max(position) FROM editorial.write_basis WHERE partition_no = $1
         ), 0))
         WHERE partition_no = $1`,
        [hotPartition],
      );
    },
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const tx = randomUUID();
      const facts = itemFacts(id, { labels: { en: `Seed ${ordinal}` } });
      const position =
        1_000_000_000 + createHash('sha256').update(name).digest().readUIntBE(0, 3) * 2_100_000 + ordinal * 128;
      const receiptRows = Array.from({ length: 4 }, (_, index) => ({
        partition_no: route >>> 4,
        principal_kind: 'account',
        principal_id: index === 0 ? actor.accountId : newId(route),
        command_kind: 'subject.create',
        idempotency_key: `${ordinal}-${index}-${randomUUID()}`,
        request_digest: createHash('sha256').update(`${ordinal}-${index}`).digest(),
        epoch: 1,
        position: position + index,
        transaction_id: randomUUID(),
        response: projectSubject(id, facts),
      }));
      const outboxRows = Array.from({ length: 4 }, (_, index) => ({
        partition_no: route >>> 4,
        position: position + index,
        event_seq: 0,
        event_count: 1,
        epoch: 1,
        id: newId(route),
        type: 'com.rezics.subject.created.v1',
        subject: id,
        data: { id },
      }));
      const basisRows = Array.from({ length: 4 }, (_, index) => ({
        partition_no: route >>> 4,
        transaction_id: randomUUID(),
        epoch: 1,
        position: position + index,
        principal_kind: 'account',
        principal_id: actor.accountId,
        client_id: actor.clientId,
        requested_by: null,
      }));
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: tx }],
        'semantic.fact': facts.map((fact) => ({ ...fact, route, subject_id: id, recorded_transaction_id: tx })),
        'core.receipt': receiptRows,
        'core.outbox': outboxRows,
        'editorial.write_basis': basisRows,
      };
    },
  };
}
let anchor = '';
let partition = 0;
let anchorRoute = 0;
let account: Awaited<ReturnType<typeof readAccount>>;
const cursors = new Map<number, string>();
const subject = { type: itemType, labels: { en: 'Growth anchor' } };

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
  const target = subjectTarget(routeKey, actor.accountId, `growth-anchor-${randomUUID()}`);
  anchor = target.id;
  partition = partitionOf(target.route);
  anchorRoute = target.route;
  await createSubject(db.pool, {
    actor,
    target,
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(anchor).digest(),
    item: subject,
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $3)`,
    [Number.parseInt(actor.accountId.slice(24, 28), 16), actor.accountId, randomUUID()],
  );
  account = await readAccount(db.pool, Number.parseInt(actor.accountId.slice(24, 28), 16), actor.accountId);
  await db.admin.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', '(,)'::tstzrange, $4)`,
    [anchorRoute, anchor, actor.accountId, randomUUID()],
  );
});
afterAll(async () => {
  if (db) await db.close();
});

async function grow(database: GrowthDatabase, scale: number, previous: number, name: string) {
  const population = subjectPopulation(partition, name);
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: previous * ordinalsPerScale,
    to: scale * ordinalsPerScale,
  });
  await database.admin.query('CHECKPOINT');
}

test('Subject creation stays within its bound as N grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Subject creation stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-create-growth'),
    operation: async (database, _scale, repetition) => {
      const key = `growth-create-${randomUUID()}-${repetition}`;
      const target = { route: anchorRoute, id: newId(anchorRoute) };
      return createSubject(database.pool, {
        actor,
        target,
        idempotencyKey: key,
        digest: createHash('sha256').update(key).digest(),
        item: subject,
        release: { digest: bundledDigest, release: bundledRelease },
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
      await database.admin.query('CHECKPOINT');
    },
    operation: async (database, scale, repetition) => {
      const key = `growth-command-${scale}-${repetition}-${randomUUID()}`;
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
        async () => ({ value: null, events: [{ type: 'com.rezics.growth.v1', data: { repetition } }] }),
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

// It reads every fact of its partition until the page query is fixed.
test('Partition keyset page stays within its bound as d grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Partition keyset page stays within its bound as d grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      await grow(database, scale, previous, 'semantic-page-growth');
      // Growth is placed in the page's partition so each scale advances the keyset depth.
      // This population uses the same production subject and label-fact shape as the page read.
      const local = subjectPopulation(partition, 'semantic-page-depth');
      await seed({ pool: database.pool, admin: database.admin }, local, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
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
    operation: async (database) => {
      projectSubject(anchor, itemFacts(anchor, subject));
      return readLabels(database.pool, [anchor]);
    },
  });
  expect(report.samples).toHaveLength(3);
  expect(projectSubject(anchor, itemFacts(anchor, subject)).labels).toEqual(subject.labels);
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
  const access = createAccess({
    actions: new Map([['subject:read', { anonymous: false }]]),
    accountEvidence: () => account!,
  });
  const report = await checkGrowth(db, {
    name: 'Request authorization stays within its bound as N grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, 'semantic-authorization-growth'),
    operation: async (database) => {
      const context = { pool: database.pool, deadline: Date.now() + 5_000, account };
      const check = await accessCheck(access, actor, 'subject:read', { route: anchorRoute, id: anchor }, context);
      return withConnection(database.pool, (client) => check(client));
    },
  });
  expect(report.samples).toHaveLength(3);
}, 90_000);
