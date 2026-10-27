import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NOTIFICATION_KINDS, type Notifications } from '../../src/access/notification-kinds.ts';
import {
  createPreferenceCommands,
  notificationAllowed,
  readAccountPreferences,
  type Shelf,
} from '../../src/access/preferences.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const notifications = Object.fromEntries(
  NOTIFICATION_KINDS.filter(({ optional }) => optional).map((entry) => [entry.kind, !entry.default]),
) as Notifications;
const route = 0x4567;
const accountId = newId(route);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
const maximalShelf = (): Shelf =>
  ({
    layouts: Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `https://rezics.com/vocab/${String(index).padStart(3, '0')}${'a'.repeat(220)}`,
        'grid',
      ]),
    ),
    sorts: Object.fromEntries(
      ['in_progress', 'planned', 'completed', 'paused', 'dropped', 'all'].map((tab) => [
        tab,
        { field: 'last_activity', direction: 'desc' },
      ]),
    ),
    gridSize: 'large',
    tableColumns: [
      'cover',
      'title',
      'creator',
      'type',
      'status',
      'progress',
      'rating',
      'added',
      'started',
      'finished',
      'last_activity',
    ],
  }) as Shelf;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => db?.close());

test('preferences read stays constant as accounts with stored preferences grow', async () => {
  const report = await checkGrowth(db, {
    name: 'account preferences read',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
           VALUES ($1,$2,'actor','active',$2)`,
          [route, accountId],
        );
        await database.admin.query(
          `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,shelf,notifications,version)
           VALUES ($1,$2,1,'show',$3::jsonb,$4::jsonb,1)`,
          [route, accountId, JSON.stringify(maximalShelf()), JSON.stringify(notifications)],
        );
      }
      // Keep the smallest sample beyond the planner's tiny-table scan threshold.
      const ids = Array.from({ length: (scale - previous) * 16 }, () => newId(route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,shelf,notifications,version)
        SELECT $1,id,2,'blur',$3::jsonb,$4::jsonb,1 FROM unnest($2::uuid[]) id`,
        [route, ids, JSON.stringify(maximalShelf()), JSON.stringify(notifications)],
      );
    },
    async operation() {
      expect(await readAccountPreferences(db.pool, accountId)).toEqual({
        spoilerLevel: 1,
        suitability: 'show',
        shelf: maximalShelf(),
        notifications,
        version: 1,
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(1);
    expect(cost.statements).toBe(1);
  }
}, 60000);

test('setting a maximal shelf stays constant as accounts with stored preferences grow', async () => {
  const access = admittedAccess({ actions: new Map([['account:update', { anonymous: false }]]) });
  const commands = createPreferenceCommands({ pool: db.pool, access, clock: () => new Date() });
  const setRoute = 0x4568;
  const accounts = Array.from({ length: 24 }, () => newId(setRoute));
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
    [setRoute, accounts],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     SELECT $1, id, id, 'account:update', '(,)', id FROM unnest($2::uuid[]) id`,
    [setRoute, accounts],
  );
  const contexts: Array<{
    pool: typeof db.pool;
    deadline: number;
    actor: Awaited<ReturnType<typeof authenticateAccount>>;
  }> = [];
  for (const id of accounts)
    contexts.push({
      pool: db.pool,
      deadline: Date.now() + 60_000,
      actor: await authenticateAccount(
        access,
        { pool: db.pool, deadline: Date.now() + 10_000 },
        { accountId: id, clientId: 'growth-preferences', scopes: ['account:update'] },
      ),
    });
  let next = 0;
  const report = await checkGrowth(db, {
    name: 'account preferences set',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: (scale - previous) * 16 }, () => newId(setRoute));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
        [setRoute, ids],
      );
      await database.admin.query(
        `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,shelf,notifications,version)
        SELECT $1,id,2,'blur',$3::jsonb,$4::jsonb,1 FROM unnest($2::uuid[]) id`,
        [setRoute, ids, JSON.stringify(maximalShelf()), JSON.stringify(notifications)],
      );
      // The command reads its authorization grant and its receipt key: seed both past the planner's tiny-table scans.
      await database.admin.query(
        `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
        SELECT $1, id, id, 'account:update', '(,)', id FROM unnest($2::uuid[]) id`,
        [setRoute, ids],
      );
      await database.admin.query(
        `INSERT INTO core.receipt
          (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT $1,'account',id,'access.account.preferences',id::text,decode(repeat('0',64),'hex'),1,1,id,'{}'
        FROM unnest($2::uuid[]) id`,
        [partitionOf(setRoute), ids],
      );
    },
    async operation() {
      const context = contexts[next++];
      if (!context) throw new Error('Growth check exhausted its accounts');
      const result = await commands.setPreferences(context, {
        accountId: context.actor.accountId,
        key: Bun.randomUUIDv7(),
        expectedVersion: 0,
        shelf: maximalShelf(),
        notifications,
      });
      expect(result.value.shelf).toEqual(maximalShelf());
      expect(result.value.notifications).toEqual(notifications);
      expect(result.value.version).toBe(1);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.relations?.['access.account_preferences']?.rows).toBe(1);
  }
}, 120000);

test('notificationAllowed stays constant as accounts grow', async () => {
  const permissionRoute = 0x4569;
  const recipient = newId(permissionRoute);
  const report = await checkGrowth(db, {
    name: 'notification permission',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: (scale - previous) * 16 }, () => newId(permissionRoute));
      if (previous === 0) ids.push(recipient);
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
         SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
        [permissionRoute, ids],
      );
      await database.admin.query(
        `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,notifications,version)
         SELECT $1,id,0,'blur',$3::jsonb,1 FROM unnest($2::uuid[]) id`,
        [permissionRoute, ids, JSON.stringify(notifications)],
      );
    },
    async operation() {
      expect(await notificationAllowed(db.pool, { recipient, kind: 'reply' })).toBe(false);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(1);
    expect(cost.relations?.['access.account']?.rows).toBe(1);
    expect(cost.relations?.['access.account_preferences']?.rows).toBe(1);
  }
}, 60000);
