import { afterAll, beforeAll, expect, test } from 'bun:test';
import { derivedId, newId } from '../../src/route/route.ts';
import {
  createMembershipInverseCommands,
  MembershipInverseIncompleteError,
  readMembershipInverse,
} from '../../src/access/membership-inverse.ts';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

let database: Awaited<ReturnType<typeof openGrowthDatabase>>;
beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
});
afterAll(async () => {
  if (database) await database.close();
});

const actorRoute = 0x5292;
const groupRoute = 0x7392;
const namespace = 'd884b281-a989-8be2-a052-8097bde7456b';
const key = () => Bun.randomUUIDv7();
const population: Population = {
  name: 'membership-bootstrap-unrelated',
  hotPartition: actorRoute >>> 4,
  rows({ ordinal }) {
    const accountId = derivedId(namespace, `actor:${ordinal}`, actorRoute);
    const groupId = derivedId(namespace, `group:${ordinal}`, groupRoute);
    const reservationId = derivedId(namespace, `reservation:${ordinal}`, actorRoute);
    const transactionId = derivedId(namespace, `transaction:${ordinal}`, groupRoute);
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
      // Historical positive membership fixtures explicitly include their inverse.
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
      'access.lifecycle_coordination': [
        {
          route: actorRoute,
          account_id: accountId,
          related_account_id: groupId,
          reservation_id: reservationId,
          purpose: 'membership',
          transaction_id: transactionId,
        },
      ],
      'core.receipt': [
        {
          partition_no: actorRoute >>> 4,
          principal_kind: 'account',
          principal_id: accountId,
          command_kind: 'access.membership-inverse-bootstrapped',
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

test('one source-cursor bootstrap stays bounded and preserves historical reservation provenance across unrelated growth', async () => {
  const commands = createMembershipInverseCommands({ pool: database.pool });
  const items: { accountId: string; reservationId: string; sourceTransactionId: string; holdTransactionId: string }[] =
    [];
  // Each invocation changes exactly one membership. The call below and the
  // per-scale warmup hook bootstrap spare memberships so the measured item stays a first apply.
  async function item() {
    const accountId = newId(actorRoute);
    const groupId = newId(groupRoute);
    const reservationId = newId(actorRoute);
    const sourceTransactionId = newId(groupRoute);
    const holdTransactionId = newId(actorRoute);
    await database.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
       VALUES($1,$2,'actor','active',$5),($3,$4,'organization','active',$5)`,
      [actorRoute, accountId, groupRoute, groupId, sourceTransactionId],
    );
    await database.admin.query(
      'UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2',
      [actorRoute, accountId],
    );
    // The only missing inverse is this pre-upgrade source item behind the barrier.
    await database.admin.query(
      `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
       VALUES($1,$2,$3,'member','(,)'::tstzrange,$4)`,
      [groupRoute, groupId, accountId, sourceTransactionId],
    );
    await database.admin.query(
      `INSERT INTO access.lifecycle_membership_slot
         (route,organization_id,member_account_id,reservation_id,terminal,transaction_id)
       VALUES($1,$2,$3,$4,false,$5)`,
      [groupRoute, groupId, accountId, reservationId, sourceTransactionId],
    );
    await database.admin.query(
      `INSERT INTO access.lifecycle_coordination
         (route,account_id,related_account_id,reservation_id,purpose,transaction_id)
       VALUES($1,$2,$3,$4,'membership',$5)`,
      [actorRoute, accountId, groupId, reservationId, holdTransactionId],
    );
    items.push({ accountId, reservationId, sourceTransactionId, holdTransactionId });
    return {
      accountId,
      principal: { kind: 'organization' as const, id: groupId },
      sourceTransactionId,
      key: key(),
      reservationId,
      holdTransactionId,
    };
  }
  const warmup = await item();
  await commands.bootstrapStep(warmup);
  let input = warmup;
  const report = await checkGrowth(database, {
    name: 'membership source-cursor bootstrap',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    async grow(db, scale, previous) {
      // Ordinals here never overlap the measured scales. The same row shape puts a
      // few thousand unrelated memberships on the actor route before the first sample.
      if (previous === 0) await seed(db, population, { from: 1_000_000, to: 1_004_000 });
      await seed(db, population, { from: previous, to: scale });
      input = await item();
      for (const table of [
        'access.account',
        'access.organization_member',
        'access.membership_inverse',
        'access.lifecycle_membership_slot',
        'access.lifecycle_coordination',
        'core.receipt',
      ])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    async warmup() {
      const spare = await item();
      const outcome = await commands.bootstrapStep(spare);
      expect(outcome.value.reservationId).toBe(spare.reservationId);
      expect(outcome.value.sourceTransactionId).toBe(spare.sourceTransactionId);
      expect(outcome.replayed).toBe(false);
    },
    async operation() {
      const outcome = await commands.bootstrapStep(input);
      expect(outcome.value.reservationId).toBe(input.reservationId);
      expect(outcome.value.sourceTransactionId).toBe(input.sourceTransactionId);
      expect(outcome.replayed).toBe(false);
    },
  });
  for (const { cost } of report.samples) {
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.rows).toBeLessThan(100);
  }
  for (const { accountId, reservationId, sourceTransactionId, holdTransactionId } of items) {
    await expect(
      withConnection(database.pool, (client) => readMembershipInverse(client, { accountId })),
    ).rejects.toBeInstanceOf(MembershipInverseIncompleteError);
    const rows = await database.admin.query(
      `SELECT i.reservation_id, i.source_transaction_id, i.transaction_id,
         i.transaction_id = c.transaction_id AS matched
       FROM access.membership_inverse i
       JOIN access.lifecycle_coordination c ON c.route=i.route AND c.account_id=i.account_id
         AND c.reservation_id=i.reservation_id
       WHERE i.route=$1 AND i.account_id=$2`,
      [actorRoute, accountId],
    );
    expect(rows.rows).toEqual([
      {
        reservation_id: reservationId,
        source_transaction_id: sourceTransactionId,
        transaction_id: holdTransactionId,
        matched: true,
      },
    ]);
  }
}, 30000);
