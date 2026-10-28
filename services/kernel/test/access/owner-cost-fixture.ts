import { createPool } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import ownersRead from '../../src/access/lifecycle-owners.sql';

export type Plan = {
  'Node Type': string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Index Cond'?: string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: Plan[];
};
type OwnerCostPools = {
  readonly pool: ReturnType<typeof createPool>;
  readonly reader: ReturnType<typeof createPool>;
};
export const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

export async function ownerCostFixture(pools?: OwnerCostPools) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const ownsPools = pools === undefined;
  const pool = pools?.pool ?? createPool(url);
  const reader = pools?.reader ?? createPool(url);
  const commandPlans: Plan[] = [];
  // Observe the private guard on the actual command client, with its real
  // authoritative-time parameters, before the membership mutation or denial.
  pool.on('connect', (client) => {
    client.query = new Proxy(client.query, {
      apply(query, receiver, args) {
        const statement = args[0];
        const text = typeof statement === 'string' ? statement : statement?.text;
        if (text !== ownersRead.sql) return Reflect.apply(query, receiver, args);
        return (async () => {
          const values = typeof statement === 'string' ? args[1] : statement.values;
          const result = await Reflect.apply(query, receiver, [
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
            values,
          ]);
          commandPlans.push(result.rows[0]['QUERY PLAN'][0].Plan as Plan);
          return Reflect.apply(query, receiver, args);
        })();
      },
    });
  });
  const route = 0x7310;
  const organizationId = newId(route);
  const otherOrganization = newId(route);
  const elsewhere = newId(route + 1);
  const owners = Array.from({ length: 4 }, () => newId(0x1234));
  const member = newId(0x1234);
  const expired = newId(0x1234);
  const absent = newId(0x1234);
  const actor = owners[0]!;
  const at = new Date().toISOString();
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const commands = createLifecycleCommands({ pool, access });
  const internal = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(51),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const key = () => Bun.randomUUIDv7();
  for (const [id, kind] of [
    [organizationId, 'organization'] as const,
    ...[...owners, member].map((id) => [id, 'actor'] as const),
  ]) {
    await reader.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,$3,'active',$2)`,
      [routeOf(id), id, kind],
    );
  }
  await reader.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,$2,$3,action,'(,)'::tstzrange,$3 FROM unnest($4::text[]) action`,
    [route, organizationId, actor, ['organization:membership', 'account:delete']],
  );
  async function context() {
    return {
      actor: await authenticateAccount(
        access,
        { pool, deadline: Date.now() + 10_000 },
        {
          accountId: actor,
          clientId: 'owner-cost',
          requestedBy: null,
          authnEpoch: 1,
          scopes: [...LIFECYCLE_ACTIONS.keys()],
        },
      ),
      account: await readAccount(reader, routeOf(actor)!, actor),
      deadline: Date.now() + 5000,
    };
  }
  // One family at 1x/8x/64x. Current measured owners stay fixed while unrelated
  // members, same-member expired history, same-route organizations and routes grow.
  async function seed(scale: number, ownerCount = owners.length) {
    await reader.query('TRUNCATE access.organization_member');
    await reader.query(
      `INSERT INTO access.organization_member (route,organization_id,member_account_id,role,valid,transaction_id)
       SELECT $1::integer,$2::uuid,id,'owner','[2025-01-01,)'::tstzrange,$2 FROM unnest($3::uuid[]) id
       UNION ALL SELECT $1::integer,$2::uuid,$4::uuid,'member','(,)'::tstzrange,$2`,
      [route, organizationId, owners.slice(0, ownerCount), member],
    );
    await reader.query(
      `INSERT INTO access.organization_member (route,organization_id,member_account_id,role,valid,transaction_id)
       SELECT anchor.route,anchor.org,
         CASE WHEN category=1 THEN $4::uuid WHEN category=2 THEN $5::uuid
              ELSE md5(category::text || ':' || i::text)::uuid END,
         CASE WHEN category=0 THEN 'member' ELSE 'owner' END,
         CASE WHEN category IN (1,2) THEN
           tstzrange('2000-01-01'::timestamptz + i * interval '1 hour',
                     '2000-01-01'::timestamptz + i * interval '1 hour' + interval '30 minutes','[)')
           ELSE '(,)'::tstzrange END,$2
       FROM generate_series(1,$3::integer) i
       CROSS JOIN (VALUES (0,$1::integer,$2::uuid),(1,$1,$2),(2,$1,$2),
                          (3,$1,$6::uuid),(4,$1::integer+1,$7::uuid)) anchor(category,route,org)`,
      [route, organizationId, scale, actor, expired, otherOrganization, elsewhere],
    );
    await reader.query('VACUUM (ANALYZE) access.organization_member');
  }
  function parameters(memberId: string, instant = at) {
    return { route, organization_id: organizationId, member_id: memberId, at: instant };
  }
  async function read(memberId: string, instant = at) {
    return ownersRead.run(reader, parameters(memberId, instant));
  }
  async function explain(memberId: string) {
    const input = parameters(memberId);
    const values = ownersRead.params.map((name) => input[name as keyof typeof input]);
    const result = await reader.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${ownersRead.sql}`, values);
    return result.rows[0]['QUERY PLAN'][0].Plan as Plan;
  }
  async function change(memberId: string, role: 'owner' | 'member' | null) {
    const reservation = await internal.reserveCoordination({
      accountId: memberId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    });
    return commands.setMembership(await context(), {
      organizationId,
      memberAccountId: memberId,
      reservationId: reservation.value.reservationId,
      role,
      key: key(),
    });
  }
  return {
    pool,
    reader,
    route,
    organizationId,
    owners,
    actor,
    member,
    expired,
    absent,
    at,
    seed,
    read,
    explain,
    commandPlans,
    change,
    tombstone: async () => commands.tombstone(await context(), { accountId: organizationId, key: key() }),
    close: async () => {
      if (ownsPools) {
        await pool.end();
        await reader.end();
      }
    },
  };
}
