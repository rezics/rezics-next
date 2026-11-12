import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NOTIFICATION_KINDS, type Notifications } from '../../src/access/notification-kinds.ts';
import {
  createPreferenceCommands,
  notificationAllowed,
  projectReadingAdvice,
  projectShelfAdvice,
  readAccountPreferences,
  type Shelf,
} from '../../src/access/preferences.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const notifications = Object.fromEntries(
  NOTIFICATION_KINDS.filter(({ optional }) => optional).map((entry) => [entry.kind, !entry.default]),
) as Notifications;
const defaultNotifications = Object.fromEntries(
  NOTIFICATION_KINDS.filter(({ optional }) => optional).map(({ kind, default: enabled }) => [kind, enabled]),
) as Notifications;
const preferenceSeededRelations = ['access.account', 'access.account_preferences'] as const;
const commandSeededRelations = [...preferenceSeededRelations, 'access.resource_grant', 'core.receipt'] as const;
const route = 0x4567;
const accountId = newId(route);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;

const maximalShelf = (): Shelf =>
  ({
    layouts: Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `https://rezics.com/vocab/${String(index).padStart(3, '0')}${'a'.repeat(228)}`,
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

/** Bulk-seeds route-valid IDs without sending a scale-sized UUID array through the driver. */
async function seedPreferencePopulation(
  database: GrowthDatabase,
  route: number,
  count: number,
  options: {
    readonly shelf?: Shelf;
    readonly spoilerLevel?: 0 | 1 | 2;
    readonly grant?: boolean;
    readonly receipt?: boolean;
  } = {},
): Promise<void> {
  const client = await database.admin.connect();
  let transactionOpen = false;
  let primary: unknown;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      `CREATE TEMP TABLE growth_preference_seed_ids ON COMMIT DROP AS
       WITH uuid_values AS MATERIALIZED (
         SELECT gen_random_uuid()::text AS value
         FROM generate_series(1, $2::integer)
       )
       SELECT (
         substr(value, 1, 14) || '7' || substr(value, 16, 9) ||
         lpad(to_hex($1::integer), 4, '0') || right(value, 8)
       )::uuid AS account_id
       FROM uuid_values`,
      [route, count],
    );
    await client.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       SELECT $1, account_id, 'actor', 'active', account_id FROM growth_preference_seed_ids`,
      [route],
    );
    if (options.shelf !== undefined) {
      await client.query(
        `INSERT INTO access.account_preferences
           (route, account_id, spoiler_level, suitability, shelf, notifications, version)
         SELECT $1, account_id, $2, 'blur', $3::jsonb, $4::jsonb, 1
         FROM growth_preference_seed_ids`,
        [route, options.spoilerLevel ?? 2, JSON.stringify(options.shelf), JSON.stringify(notifications)],
      );
    } else {
      await client.query(
        `INSERT INTO access.account_preferences
           (route, account_id, spoiler_level, suitability, notifications, version)
         SELECT $1, account_id, $2, 'blur', $3::jsonb, 1
         FROM growth_preference_seed_ids`,
        [route, options.spoilerLevel ?? 0, JSON.stringify(notifications)],
      );
    }
    if (options.grant)
      await client.query(
        `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
         SELECT $1, account_id, account_id, 'account:update', '(,)', account_id
         FROM growth_preference_seed_ids`,
        [route],
      );
    if (options.receipt)
      await client.query(
        `INSERT INTO core.receipt
           (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
            epoch, position, transaction_id, response)
         SELECT $1, 'account', account_id, 'access.account.preferences', account_id::text,
                decode(repeat('0', 64), 'hex'), 1, 1, account_id, '{}'
         FROM growth_preference_seed_ids`,
        [partitionOf(route)],
      );
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    primary = error;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (cleanup) {
        primary = cleanup;
        throw new AggregateError([error, cleanup], 'Could not roll back preference growth seed', { cause: error });
      }
    }
    throw error;
  } finally {
    client.release(primary instanceof Error ? primary : undefined);
  }
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
afterAll(async () => db?.close());

test('preferences read stays constant as accounts with stored preferences grow', async () => {
  expect(await readAccountPreferences(db.pool, newId(route))).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {},
    notifications: defaultNotifications,
    version: 0,
  });
  const report = await checkGrowth(db, {
    name: 'account preferences read',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    seededRelations: preferenceSeededRelations,
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
      await seedPreferencePopulation(database, route, (scale - previous) * 16, {
        shelf: maximalShelf(),
        spoilerLevel: 2,
      });
    },
    async operation() {
      const values = await readAccountPreferences(db.pool, accountId);
      expect(values).toEqual({
        spoilerLevel: 1,
        suitability: 'show',
        shelf: maximalShelf(),
        notifications,
        version: 1,
      });
      expect(projectReadingAdvice(values, { writable: true }).reading.effective).toEqual({
        spoilerLevel: 1,
        suitability: 'show',
      });
      expect(projectShelfAdvice(values.shelf).effective).toEqual(maximalShelf());
      expect(projectShelfAdvice(values.shelf).defaults).toEqual({});
      expect(projectShelfAdvice(values.shelf).limits.maxLayouts).toBe(32);
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
  const actors: Array<Awaited<ReturnType<typeof authenticateAccount>>> = [];
  for (const id of accounts)
    actors.push(
      await authenticateAccount(
        access,
        { pool: db.pool, deadline: Date.now() + 10_000 },
        { accountId: id, clientId: 'growth-preferences', scopes: ['account:update'] },
      ),
    );
  let next = 0;
  const report = await checkGrowth(db, {
    name: 'account preferences set',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    seededRelations: commandSeededRelations,
    async grow(database, scale, previous) {
      await seedPreferencePopulation(database, setRoute, (scale - previous) * 16, {
        shelf: maximalShelf(),
        spoilerLevel: 2,
        grant: true,
        receipt: true,
      });
    },
    async operation() {
      const actor = actors[next++];
      if (!actor) throw new Error('Growth check exhausted its accounts');
      const context = { pool: db.pool, deadline: Date.now() + 60_000, actor };
      const input = {
        accountId: actor.accountId,
        key: Bun.randomUUIDv7(),
        expectedVersion: 0,
        shelf: maximalShelf(),
        notifications,
      };
      const result = await commands.setPreferences(context, input);
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

test('preference page projection stays constant as unrelated preference rows and receipts grow', async () => {
  const pageRoute = 0x456a;
  const selected = newId(pageRoute);
  const report = await checkGrowth(db, {
    name: 'account preference page projection',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    seededRelations: commandSeededRelations,
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
           VALUES ($1,$2,'actor','active',$2)`,
          [pageRoute, selected],
        );
        await database.admin.query(
          `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,shelf,notifications,version)
           VALUES ($1,$2,1,'show',$3::jsonb,$4::jsonb,1)`,
          [pageRoute, selected, JSON.stringify(maximalShelf()), JSON.stringify(notifications)],
        );
      }
      await seedPreferencePopulation(database, pageRoute, (scale - previous) * 16, {
        shelf: maximalShelf(),
        spoilerLevel: 2,
        receipt: true,
      });
    },
    async operation() {
      const values = await readAccountPreferences(db.pool, selected);
      expect(projectReadingAdvice(values, { writable: false }).allowedActions.update).toEqual({
        allowed: false,
        reason: 'not_authorized',
      });
      expect(projectShelfAdvice(values.shelf).supported.tableColumns).toContain('rating');
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(1);
    expect(cost.statements).toBe(1);
  }
}, 60000);

test('notificationAllowed stays constant as accounts grow', async () => {
  const permissionRoute = 0x4569;
  const recipient = newId(permissionRoute);
  const report = await checkGrowth(db, {
    name: 'notification permission',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    seededRelations: preferenceSeededRelations,
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
           VALUES ($1,$2,'actor','active',$2)`,
          [permissionRoute, recipient],
        );
        await database.admin.query(
          `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,notifications,version)
           VALUES ($1,$2,0,'blur',$3::jsonb,1)`,
          [permissionRoute, recipient, JSON.stringify(notifications)],
        );
      }
      await seedPreferencePopulation(database, permissionRoute, (scale - previous) * 16, {
        spoilerLevel: 0,
      });
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
