import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MembershipWorkInput, MembershipWorkReservation } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { createLifecycleInternals, LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { createMembershipWorkPorts } from '../../src/access/membership-work.ts';
import ownersRead from '../../src/access/lifecycle-owners.sql';
import commandTime from '../../src/command/time.sql';
import { newId, routeOf } from '../../src/route/route.ts';
import { authenticated } from './membership-work-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
const env = { KERNEL_ROUTE_KEY: Buffer.alloc(32, 59).toString('base64url') };
const native = createLifecycleInternals({
  pool,
  routeKey: Buffer.alloc(32, 59),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const key = () => randomUUID();

function ports(connection: typeof pool, actor: string) {
  return createMembershipWorkPorts({ pool: connection, env }, { authorize: async () => authenticated(pool, actor) });
}

async function fixture(twoOwners = true) {
  const organizationId = newId(0x7820);
  const first = newId(0x3820);
  const second = newId(0x3830);
  for (const accountId of [first, second])
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",
      [routeOf(accountId), accountId],
    );
  const setup = ports(pool, first);
  const principal = { kind: 'organization' as const, id: organizationId };
  const held = (await setup.reserve({ accountId: first, principal, key: key() })).value;
  await native.createOrganization({
    organizationId,
    ownerAccountId: first,
    ownerReservationId: held.reservationId,
    key: key(),
  });
  const other = (await setup.reserve({ accountId: second, principal, key: key() })).value;
  const input = (accountId: string, role: 'owner' | 'member' | null): MembershipWorkInput => ({
    kind: 'membership',
    principal,
    memberAccountId: accountId,
    role,
    authorization: 'authenticated-fixture',
  });
  async function publish(
    boundary: ReturnType<typeof ports>,
    reservation: MembershipWorkReservation,
    role: 'owner' | 'member' | null,
  ) {
    const change = input(reservation.accountId, role);
    const request = await boundary.authorize(change.authorization, change);
    return boundary.publish(request, change, reservation, key());
  }
  if (twoOwners) await publish(setup, other, 'owner');
  async function owners() {
    return (
      await pool.query(
        "SELECT member_account_id::text FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND role='owner' AND upper_inf(valid)",
        [routeOf(organizationId), organizationId],
      )
    ).rows;
  }
  return { organizationId, first, second, held, other, publish, owners };
}

// Like the process-death fixture, wrap the real native publication boundary.
// Observe SQL results on its real client so a barrier can hold the transaction
// after its owner check without replacing any check, write or lock.
function boundaryPool(hooks: { sampled?(at: string): Promise<void>; checked?(): Promise<void> }) {
  const connection = createPool(process.env.DATABASE_URL!);
  connection.on('connect', (client) => {
    client.query = new Proxy(client.query, {
      apply(query, receiver, args) {
        const statement = args[0];
        const sql = typeof statement === 'string' ? statement : statement?.text;
        if (sql !== commandTime.sql && sql !== ownersRead.sql) return Reflect.apply(query, receiver, args);
        return (async () => {
          const result = await Reflect.apply(query, receiver, args);
          if (sql === commandTime.sql && hooks.sampled) {
            const sampled = hooks.sampled;
            delete hooks.sampled;
            await sampled(result.rows[0].at);
          }
          if (sql === ownersRead.sql && hooks.checked) {
            expect(result.rows).toEqual([{ owners: 2, target: 1 }]);
            const checked = hooks.checked;
            delete hooks.checked;
            await checked();
          }
          return result;
        })();
      },
    });
  });
  return connection;
}

async function reached<T>(barrier: Promise<T>, operation: Promise<unknown>) {
  return Promise.race([
    barrier,
    operation.then(() => {
      throw new Error('Native publication completed before its barrier');
    }),
  ]);
}

afterAll(async () => pool.end());

for (const role of [null, 'member'] as const)
  test(`two owners concurrently leave / ${role === null ? 'leave' : 'demote'}: exactly one change is refused after the native check`, async () => {
    const f = await fixture();
    const sampled = Promise.withResolvers<string>();
    const resumeEarlier = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const resumeChecked = Promise.withResolvers<void>();
    const earlierPool = boundaryPool({
      async sampled(at) {
        sampled.resolve(at);
        await resumeEarlier.promise;
      },
    });
    const laterPool = boundaryPool({
      async checked() {
        checked.resolve();
        await resumeChecked.promise;
      },
    });
    const earlier = f.publish(ports(earlierPool, f.first), f.held, null);
    const earlierResult = Promise.allSettled([earlier]);
    let later: Promise<unknown> | undefined;
    try {
      const at = await reached(sampled.promise, earlier);
      // The earlier native attempt has sampled T but has not taken any locks.
      // Let the later attempt reach its check while holding the organization.
      later = f.publish(ports(laterPool, f.first), f.other, role);
      await reached(checked.promise, later);
      expect(await f.owners()).toHaveLength(2);
      resumeChecked.resolve();
      await later;
      // Prove this schedule exposes stale-time skew: after the later commit,
      // the old command timestamp still sees two owners, the live guard one.
      const probe = {
        route: routeOf(f.organizationId)!,
        organization_id: f.organizationId,
        member_id: f.first,
      };
      expect(await ownersRead.run(pool, { ...probe, at })).toEqual({ owners: 2, target: 1 });
      const live = (await pool.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
      expect(await ownersRead.run(pool, { ...probe, at: live })).toEqual({ owners: 1, target: 1 });
      resumeEarlier.resolve();
      const outcomes = await Promise.allSettled([earlier, later]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.filter((result) => result.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toBeInstanceOf(LifecycleDeniedError);
      expect(await f.owners()).toEqual([{ member_account_id: f.first }]);
    } finally {
      resumeChecked.resolve();
      resumeEarlier.resolve();
      await earlierResult;
      if (later) await Promise.allSettled([later]);
      await earlierPool.end();
      await laterPool.end();
    }
  });

test('a sole owner cannot leave, including a repeated native attempt', async () => {
  const f = await fixture(false);
  const boundary = ports(pool, f.first);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.publish(boundary, f.held, null)).rejects.toBeInstanceOf(LifecycleDeniedError);
    expect(await f.owners()).toEqual([{ member_account_id: f.first }]);
  }
});
