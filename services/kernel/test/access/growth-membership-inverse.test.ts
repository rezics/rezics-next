import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createMembershipInverseCommands, readMembershipInverse } from '../../src/access/membership-inverse.ts';
import { capture, openGrowthDatabase } from '../support/growth-capture.ts';
import { costOf, type Cost } from '../support/growth-cost.ts';
import { assertGrowth, type GrowthSample } from '../support/growth-bound.ts';
import { seed, type Population } from '../support/growth-seed.ts';

let database: Awaited<ReturnType<typeof openGrowthDatabase>>;
beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
});
afterAll(async () => {
  if (database) await database.close();
});
const key = () => Bun.randomUUIDv7();
const actorRoute = 0x5291;
const groupRoute = 0x7391;
const namespace = 'be28c354-4c3d-8843-84d5-bb2735daff73';
const population: Population = {
  name: 'membership-inverse-unrelated',
  hotPartition: actorRoute >>> 4,
  rows({ ordinal }) {
    const accountId = derivedId(namespace, `actor:${ordinal}`, actorRoute);
    const groupId = derivedId(namespace, `group:${ordinal}`, groupRoute);
    const reservationId = derivedId(namespace, `reservation:${ordinal}`, actorRoute);
    const transactionId = derivedId(namespace, `transaction:${ordinal}`, actorRoute);
    return {
      'access.account': [
        { route: actorRoute, account_id: accountId, kind: 'actor', state: 'active', transaction_id: transactionId },
        {
          route: groupRoute,
          account_id: groupId,
          kind: 'organization',
          state: 'active',
          transaction_id: transactionId,
        },
      ],
      'access.membership_inverse': [
        {
          route: actorRoute,
          account_id: accountId,
          kind: 'organization',
          group_id: groupId,
          reservation_id: reservationId,
          transaction_id: transactionId,
        },
      ],
      'access.lifecycle_coordination': [
        {
          route: actorRoute,
          account_id: accountId,
          related_account_id: groupId,
          purpose: 'membership',
          reservation_id: reservationId,
          transaction_id: transactionId,
        },
      ],
      'access.organization_member': [
        {
          route: groupRoute,
          organization_id: groupId,
          member_account_id: accountId,
          role: 'member',
          valid: '(,)',
          transaction_id: transactionId,
        },
      ],
      'access.lifecycle_membership_slot': [
        {
          route: groupRoute,
          organization_id: groupId,
          member_account_id: accountId,
          reservation_id: reservationId,
          terminal: false,
          transaction_id: transactionId,
        },
      ],
      'access.membership_inverse_terminal': [
        {
          route: actorRoute,
          account_id: accountId,
          kind: 'organization',
          group_id: groupId,
          reservation_id: derivedId(namespace, `previous:${ordinal}`, actorRoute),
          reservation_transaction_id: transactionId,
          proof_transaction_id: transactionId,
          transaction_id: transactionId,
        },
      ],
      'core.receipt': [
        {
          partition_no: actorRoute >>> 4,
          principal_kind: 'account',
          principal_id: accountId,
          command_kind: 'access.membership-inverse-reserved',
          idempotency_key: `unrelated:${ordinal}`,
          request_digest: new Uint8Array(32),
          epoch: 1,
          position: ordinal + 1,
          transaction_id: transactionId,
          response: {},
        },
      ],
    };
  },
};

test('native inverse reserve, read and terminal release stay bounded as unrelated actor and group anchors grow', async () => {
  const accountId = newId(actorRoute);
  const principal = { kind: 'organization' as const, id: newId(groupRoute) };
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$3)`,
    [routeOf(accountId), accountId, key()],
  );
  const commands = createMembershipInverseCommands({ pool: database.pool });
  const lifecycle = createLifecycleInternals({
    pool: database.pool,
    routeKey: new Uint8Array(32).fill(43),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  for (const kind of ['organization', 'realm'] as const)
    await commands.reserve({ accountId, principal: { kind, id: newId(groupRoute) }, key: key() });
  // Resolve reylo's catalog types before measuring command statements and plans.
  await withConnection(database.pool, (client) => readMembershipInverse(client, { accountId }));
  const warm = await commands.reserve({ accountId, principal, key: key() });
  await lifecycle.terminalizeMembership({
    organizationId: principal.id,
    memberAccountId: accountId,
    reservationId: warm.value.reservationId,
    key: key(),
  });
  await commands.release({ ...warm.value, key: key() });
  const samples: Record<'reserve' | 'read' | 'release', (GrowthSample & { cost: Cost })[]> = {
    reserve: [],
    read: [],
    release: [],
  };
  // Ordinals here never overlap the measured scales. A few thousand unrelated rows keep the smallest
  // sample off the sequential scans a tiny table gets.
  await seed(database, population, { from: 1_000_000, to: 1_004_000 });
  let from = 0;
  for (const scale of [256, 1024, 4096]) {
    await seed(database, population, { from, to: scale });
    from = scale;
    await database.admin.query('ANALYZE access.membership_inverse');
    const reserved = await capture(database, () => commands.reserve({ accountId, principal, key: key() }));
    samples.reserve.push({ scale, cost: costOf(reserved.capture) });
    const read = await capture(database, () =>
      withConnection(database.pool, (client) => readMembershipInverse(client, { accountId })),
    );
    expect(read.value).toHaveLength(3);
    samples.read.push({ scale, cost: costOf(read.capture) });
    await lifecycle.terminalizeMembership({
      organizationId: principal.id,
      memberAccountId: accountId,
      reservationId: reserved.value.value.reservationId,
      key: key(),
    });
    const released = await capture(database, () => commands.release({ ...reserved.value.value, key: key() }));
    samples.release.push({ scale, cost: costOf(released.capture) });
    expect(released.value.value.proofTransactionId).toBeDefined();
  }
  for (const operation of ['reserve', 'read', 'release'] as const) {
    assertGrowth(samples[operation], { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
    for (const { cost } of samples[operation]) {
      expect(cost.plans).toBeGreaterThan(0);
      expect(cost.rows).toBeLessThan(100);
    }
  }
}, 30000);
