import { expect } from 'bun:test';
import { readRealmMembershipInterval } from '../../../src/community/membership.ts';
import { newId, partitionOf } from '../../../src/route/route.ts';
import { createNativeContentSystem } from '../../content/support/native-system.ts';
import { capture, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../../support/growth.ts';

export const scales = [256, 1024, 4096] as const;
export const axes = ['unrelated keys', 'closed history'] as const;
export const outcomes = ['current', 'expired'] as const;
export type Axis = (typeof axes)[number];
export type Outcome = (typeof outcomes)[number];
const baseline = 256;
const route = 0x2130;
const since = '2029-01-01T00:00:00.000Z';
const until = '2029-12-01T00:00:00.000Z';
const at = '2030-01-01T00:00:00.000Z';
const historyStart = Date.parse('2020-01-01T00:00:00.000Z');

function planNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Record<string, unknown>;
  return [...(typeof node['Node Type'] === 'string' ? [node] : []), ...Object.values(node).flatMap(planNodes)];
}

/** Native identity/runtime composition stays unchanged; only interval-reader temporal inputs are seeded. */
export async function membershipIntervalAxesFixture() {
  const system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  let db: GrowthDatabase;
  try {
    db = await openGrowthDatabase(system.database.pool.options.connectionString!);
  } catch (error) {
    await system.close();
    throw error;
  }
  db.pool.options.max = 1;
  const realmId = newId(route);
  const unrelatedRealmId = newId(route);
  const accountId = system.actors.author.actor.accountId;
  const reservationId = newId(route);
  const transactionId = newId(route);
  const history: Population = {
    name: 'interval-axes-selected-history',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'community.realm_member': [{
        route,
        realm_id: realmId,
        account_id: accountId,
        role: 'member',
        valid: `[${new Date(historyStart + ordinal * 2000).toISOString()},${new Date(historyStart + ordinal * 2000 + 1000).toISOString()})`,
        reservation_id: newId(route),
        transaction_id: newId(route),
      }],
    }),
  };
  const unrelated: Population = {
    name: 'interval-axes-unrelated-keys',
    hotPartition: partitionOf(route),
    hotShare: 1,
    // All pressure stays on the selected route, so partition pruning cannot hide its growth.
    rows: () => ({
      'community.realm_member': [{
        route,
        realm_id: unrelatedRealmId,
        account_id: newId(route),
        role: 'member',
        valid: `[${since},)`,
        reservation_id: newId(route),
        transaction_id: newId(route),
      }],
    }),
  };

  async function reset(axis: Axis, outcome: Outcome) {
    // Delete only this fixture's rows. IDs, reservation, interval endpoints and read time remain fixed.
    await db.admin.query(
      'DELETE FROM community.realm_member WHERE route=$1 AND realm_id IN ($2,$3)',
      [route, realmId, unrelatedRealmId],
    );
    await db.admin.query(
      `INSERT INTO community.realm_member
         (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
       VALUES ($1,$2,$3,'member',tstzrange($4::timestamptz,$5::timestamptz,'[)'),$6,$7)`,
      [route, realmId, accountId, since, outcome === 'current' ? null : until, reservationId, transactionId],
    );
    await seed(db, axis === 'unrelated keys' ? history : unrelated, { from: 0, to: baseline });
  }

  async function operation(outcome: Outcome) {
    expect(await readRealmMembershipInterval(db.pool, realmId, accountId, at)).toEqual(
      outcome === 'current' ? { since, reservationId } : null,
    );
  }

  async function grow(axis: Axis, outcome: Outcome, scale: number, previous: number) {
    await seed(db, axis === 'unrelated keys' ? unrelated : history, { from: previous, to: scale });
    const counts = await db.admin.query(
      `SELECT
         count(*) FILTER (WHERE realm_id=$2 AND account_id=$3 AND lower(valid)<$5::timestamptz)::integer AS history,
         count(*) FILTER (WHERE realm_id=$4)::integer AS unrelated,
         count(*) FILTER (WHERE realm_id=$2 AND account_id=$3 AND lower(valid)=$5::timestamptz)::integer AS selected
       FROM community.realm_member WHERE route=$1 AND realm_id IN ($2,$4)`,
      [route, realmId, accountId, unrelatedRealmId, since],
    );
    expect(counts.rows).toEqual([{
      history: axis === 'closed history' ? scale : baseline,
      unrelated: axis === 'unrelated keys' ? scale : baseline,
      selected: 1,
    }]);
    await db.admin.query('ANALYZE community.realm_member');
    await operation(outcome); // Initialize the SQL reader outside plan observation.
    const observed = await capture(db, () => operation(outcome));
    expect(planNodes(observed.capture.plans).map((node) => ({
      type: node['Node Type'],
      relation: node['Relation Name'],
      index: node['Index Name'],
    }))).toEqual([{ type: 'Index Scan', relation: 'realm_member', index: 'realm_member_open' }]);
  }

  return {
    db,
    reset,
    grow,
    operation,
    async close() {
      try { await db.close(); } finally { await system.close(); }
    },
  };
}
