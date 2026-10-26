import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readRealmMembershipInterval } from '../../src/community/membership.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const route = 0x2130;
const realmId = newId(route);
const accountId = newId(route);
const reservationId = newId(route);
const since = '2029-01-01T00:00:00.000Z';
const at = '2030-01-01T00:00:00.000Z';
const historyStart = Date.parse('2020-01-01T00:00:00.000Z');
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await db.admin.query(
    `INSERT INTO community.realm_member
       (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     VALUES ($1,$2,$3,'member',tstzrange($4::timestamptz,NULL,'[)'),$5,$6)`,
    [route, realmId, accountId, since, reservationId, newId(route)],
  );
}, 120_000);

afterAll(async () => db?.close());

function planNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Record<string, unknown>;
  return [...(typeof node['Node Type'] === 'string' ? [node] : []), ...Object.values(node).flatMap(planNodes)];
}

test('current membership is one index point read as the same account and Realm accumulate closed intervals', async () => {
  const plans: unknown[] = [];
  const operation = async () => {
    expect(await readRealmMembershipInterval(db.pool, realmId, accountId, at)).toEqual({ since, reservationId });
  };
  const report = await checkGrowth(db, {
    name: 'current Realm membership closed history',
    scales: [2048, 8192, 32768],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    slack: { rows: { absolute: 0, relative: 0 } },
    async grow(_database, scale, previous) {
      await seed(
        db,
        {
          name: 'membership-history-neighbours',
          hotPartition: partitionOf(route),
          hotShare: 0,
          rows: ({ route: memberRoute }) => ({
            'community.realm_member': [
              {
                route: memberRoute,
                realm_id: newId(memberRoute),
                account_id: newId(memberRoute),
                role: 'member',
                valid: `[${since},)`,
                reservation_id: newId(memberRoute),
                transaction_id: newId(memberRoute),
              },
            ],
          }),
        },
        { from: previous === 0 ? 0 : 65_536 * (previous / 2048) ** 1.5, to: 65_536 * (scale / 2048) ** 1.5 },
      );
      await seed(
        db,
        {
          name: 'membership-closed-history',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows: ({ ordinal }) => ({
            'community.realm_member': [
              {
                route,
                realm_id: realmId,
                account_id: accountId,
                role: 'member',
                valid: `[${new Date(historyStart + ordinal * 2000).toISOString()},${new Date(historyStart + ordinal * 2000 + 1000).toISOString()})`,
                reservation_id: newId(route),
                transaction_id: newId(route),
              },
            ],
          }),
        },
        { from: previous, to: scale },
      );
      // Refresh the key-frequency statistics after each population grows.
      await db.admin.query('ANALYZE community.realm_member');
      const count = await db.admin.query(
        `SELECT count(*)::integer AS count FROM community.realm_member
         WHERE route = $1 AND realm_id = $2 AND account_id = $3 AND NOT upper_inf(valid)`,
        [route, realmId, accountId],
      );
      expect(count.rows[0].count).toBe(scale);
      // Initialize the SQL reader before capturing the operation's plan.
      await operation();
      plans.push((await capture(db, operation)).capture.plans);
    },
    operation,
  });

  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(1);
    expect(cost.rows).toBe(1);
    expect(cost.relations?.['community.realm_member']).toMatchObject({ rows: 1, nodes: 1, sequentialScans: 0 });
  }
  for (const plan of plans) {
    expect(planNodes(plan)).toMatchObject([
      { 'Node Type': 'Index Scan', 'Relation Name': 'realm_member', 'Index Name': 'realm_member_open' },
    ]);
  }
  expect(await readRealmMembershipInterval(db.pool, realmId, accountId, since)).toEqual({ since, reservationId });
  expect(await readRealmMembershipInterval(db.pool, realmId, accountId, '2020-01-01T00:00:00.000Z')).toBeNull();
}, 1_200_000);
