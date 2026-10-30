import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/permission.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createOperatorCommands, OperatorDeniedError } from '../../src/access/operator.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import type { AccountActor, ActionCatalogue } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const actions: ActionCatalogue = new Map([
  ...LIFECYCLE_ACTIONS,
  ['account:manage', { anonymous: false }],
  ['subject:read', { anonymous: false }],
]);
const access = admittedAccess({ actions });
const operators = createOperatorCommands({
  pool,
  access,
  actions,
  managementAction: 'account:manage',
  cursorKeys: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
});
const lifecycle = createLifecycleCommands({ pool, access });
const proofs = new Map<
  object,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(71),
  provisioningEvidence: async (proof) => proofs.get(proof as object) ?? null,
  recoveryEvidence: async () => null,
});
afterAll(() => pool.end());
let sequence = 0;
const key = () => `operator-command-${++sequence}`;
const row = (id: string) => withConnection(pool, (client) => readAccount(client, routeOf(id)!, id));
const ctx = async (id: string, scopes = [...actions.keys()], clientId = 'verified-client') => {
  const claims = { accountId: id, clientId, scopes, requestedBy: null, authnEpoch: 1 };
  let actor: AccountActor;
  try {
    actor = await authenticateAccount(access, { pool, deadline: Date.now() + 290_000 }, claims);
  } catch {
    actor = { kind: 'account', ...claims };
  }
  return { actor, account: await row(id), deadline: Date.now() + 3000 };
};
async function person() {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const handle = `operator_person_${++sequence}`;
  const reservation = await internal.reserveHandle({ accountId, handle, key: key() });
  await internal.createPending({ accountId, handle, reservationId: reservation.value.reservationId, key: key() });
  const proof = {};
  proofs.set(proof, {
    accountId,
    registrationId: reservation.value.reservationId,
    authIdentityId: accountId,
    authnEpoch: 1,
  });
  await internal.activate({ accountId, key: key(), evidence: proof });
  await operators.provisionManagementDefaults({ operatorAccountId: accountId, key: key() });
  return accountId;
}
async function org(owner: string) {
  const organizationId = newId(0x6510);
  const reservation = await internal.reserveCoordination({
    accountId: owner,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId,
    ownerAccountId: owner,
    ownerReservationId: reservation.value.reservationId,
    key: key(),
  });
  await operators.provisionManagementDefaults({ operatorAccountId: organizationId, key: key() });
  return organizationId;
}
async function member(owner: string, organizationId: string, humanId: string, role: 'owner' | 'member' | null) {
  const reservation = await internal.reserveCoordination({
    accountId: humanId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await lifecycle.setMembership(await ctx(owner), {
    organizationId,
    memberAccountId: humanId,
    role,
    reservationId: reservation.value.reservationId,
    key: key(),
  });
}
async function grant(operatorId: string, humanId: string, action = 'account:manage') {
  await pool.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)', $5)`,
    [routeOf(operatorId), operatorId, humanId, action, newId(routeOf(operatorId)!)],
  );
}
async function revoke(operatorId: string, humanId: string) {
  await pool.query(
    'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
    [routeOf(operatorId), operatorId, humanId, 'account:manage'],
  );
}
async function automate(operatorId: string) {
  const subjectId = await person();
  const reserved = await operators.reserveResponsibility({
    operatorAccountId: operatorId,
    subjectAccountId: subjectId,
    key: key(),
  });
  const input = {
    subjectAccountId: subjectId,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    operatorAccountId: operatorId,
    reservationId: reserved.value.reservationId,
    key: key(),
  };
  const relation = await operators.recordOperatorRelation(input);
  return { subjectId, reservationId: reserved.value.reservationId, relation: relation.value };
}
const approval = async (
  human: string,
  operator: string,
  subject: string,
  purpose: 'session' | 'credential-management' = 'session',
) =>
  operators.authorizeOpening(await ctx(human), {
    operatorAccountId: operator,
    subjectAccountId: subject,
    purpose,
    key: key(),
  });
const consume = async (
  human: string,
  operator: string,
  subject: string,
  receiptId: string,
  purpose: 'session' | 'credential-management' = 'session',
) =>
  operators.consumeOpening(await ctx(human), {
    operatorAccountId: operator,
    subjectAccountId: subject,
    receiptId,
    purpose,
    key: key(),
  });
async function deny(result: Promise<unknown>) {
  await expect(result).rejects.toBeInstanceOf(OperatorDeniedError);
  await expect(result).rejects.toHaveProperty('status', 403);
}

test('only eligible operators with management authority can approve an automated session', async () => {
  const human = await person();
  const other = await person();
  const { subjectId } = await automate(human);
  const second = await automate(other);
  const approved = await approval(human, human, subjectId);
  expect(approved.value).toMatchObject({
    subjectAccountId: subjectId,
    actingHumanId: human,
    operatorAccountId: human,
    purpose: 'session',
  });
  expect((await consume(human, human, subjectId, approved.value.receiptId)).value.subjectAccountId).toBe(subjectId);
  await deny(approval(other, human, subjectId));
  await deny(approval(other, other, subjectId));
  await deny(approval(subjectId, human, subjectId));
  await deny(approval(second.subjectId, human, subjectId));
  const organization = await org(other);
  await deny(approval(organization, human, subjectId));
  const stale = await approval(human, human, subjectId);
  await revoke(human, human);
  await deny(approval(human, human, subjectId));
  await deny(consume(human, human, subjectId, stale.value.receiptId));
  await grant(human, human);
  await deny(
    operators.authorizeOpening(await ctx(human, ['subject:read']), {
      operatorAccountId: human,
      subjectAccountId: subjectId,
      purpose: 'session',
      key: key(),
    }),
  );
  for (const state of ['suspended', 'deleted']) {
    // These lifecycle fixtures have no outstanding operator or owner holds.
    const other = await person();
    await setFixtureAccountState(pool, other, state);
    await grant(human, other);
    await deny(approval(other, human, subjectId));
    await revoke(human, other);
  }
  const resource = newId(0x1510);
  await grant(resource, human, 'subject:read');
  const automatedContext = await ctx(subjectId);
  const evidence = await access.prepare!(
    automatedContext.actor,
    'subject:read',
    { route: routeOf(resource)!, id: resource },
    { ...automatedContext, pool },
  );
  expect(
    await withConnection(pool, (client) =>
      access.authorize(
        client,
        automatedContext.actor,
        'subject:read',
        { route: routeOf(resource)!, id: resource },
        evidence,
      ),
    ),
  ).toBe(false);
});

test('organization management requires current separately anchored human membership and an ordinary management grant', async () => {
  const owner = await person();
  const organization = await org(owner);
  const delegated = await person();
  const ordinary = await person();
  const stranger = await person();
  await member(owner, organization, delegated, 'member');
  await member(owner, organization, ordinary, 'member');
  const { subjectId } = await automate(organization);
  expect((await approval(owner, organization, subjectId)).value.actingHumanId).toBe(owner);
  await deny(approval(ordinary, organization, subjectId));
  await deny(approval(stranger, organization, subjectId));
  await grant(organization, delegated);
  const receipt = await approval(delegated, organization, subjectId);
  expect((await consume(delegated, organization, subjectId, receipt.value.receiptId)).value).toMatchObject({
    actingHumanId: delegated,
    operatorAccountId: organization,
    subjectAccountId: subjectId,
  });
  await grant(organization, stranger);
  await deny(approval(stranger, organization, subjectId));
  const revoked = await approval(delegated, organization, subjectId);
  await revoke(organization, delegated);
  await deny(approval(delegated, organization, subjectId));
  await deny(consume(delegated, organization, subjectId, revoked.value.receiptId));
  await grant(organization, delegated);
  const removed = await approval(delegated, organization, subjectId);
  await member(owner, organization, delegated, null);
  await deny(approval(delegated, organization, subjectId));
  await deny(consume(delegated, organization, subjectId, removed.value.receiptId));
  const audit = await pool.query(
    'SELECT acting_human_id, subject_account_id, operator_account_id FROM access.operator_opening_receipt WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3',
    [routeOf(organization), organization, receipt.value.receiptId],
  );
  expect(audit.rows).toEqual([
    { acting_human_id: delegated, subject_account_id: subjectId, operator_account_id: organization },
  ]);
});

test('operator responsibility reservations prevent chains and unsafe deletion', async () => {
  const human = await person();
  const next = await person();
  const subject = await person();
  const input = { operatorAccountId: human, subjectAccountId: subject, key: key() };
  const reserved = await operators.reserveResponsibility(input);
  expect(await operators.reserveResponsibility(input)).toEqual({ ...reserved, replayed: true });
  expect((await operators.deletionEligibility(human)).safe).toBe(false);
  const page = await operators.responsibilityPage({ operatorAccountId: human, limit: 1 });
  expect(page.operators).toContainEqual({ reservationId: reserved.value.reservationId, subjectAccountId: subject });
  await expect(lifecycle.tombstone(await ctx(human), { accountId: human, key: key() })).rejects.toThrow();
  await deny(operators.releaseResponsibility({ ...input, reservationId: reserved.value.reservationId, key: key() }));
  const incoming = await operators.reserveResponsibility({
    operatorAccountId: next,
    subjectAccountId: human,
    key: key(),
  });
  await deny(
    operators.recordOperatorRelation({
      subjectAccountId: human,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      operatorAccountId: next,
      reservationId: incoming.value.reservationId,
      key: key(),
    }),
  );
  const automated = await automate(next);
  await deny(
    operators.reserveResponsibility({ operatorAccountId: automated.subjectId, subjectAccountId: subject, key: key() }),
  );
  await deny(operators.reserveResponsibility({ operatorAccountId: subject, subjectAccountId: subject, key: key() }));
  await operators.retireResponsibility({
    subjectAccountId: subject,
    operatorAccountId: human,
    reservationId: reserved.value.reservationId,
    key: key(),
  });
  await operators.releaseResponsibility({ ...input, reservationId: reserved.value.reservationId, key: key() });
  await deny(
    operators.recordOperatorRelation({
      subjectAccountId: subject,
      operatorAccountId: human,
      reservationId: reserved.value.reservationId,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      key: key(),
    }),
  );
  expect((await operators.deletionEligibility(human)).safe).toBe(true);
  await lifecycle.tombstone(await ctx(human), { accountId: human, key: key() });
  await deny(operators.reserveResponsibility({ operatorAccountId: human, subjectAccountId: subject, key: key() }));
  await expect(
    internal.reserveCoordination({
      accountId: automated.subjectId,
      relatedAccountId: newId(0x6310),
      purpose: 'membership',
      key: key(),
    }),
  ).rejects.toThrow();
});

test('reservation and deletion or automation cannot both succeed concurrently', async () => {
  for (const mutation of ['delete', 'automate']) {
    const operatorId = await person();
    const subjectId = await person();
    const other = await person();
    const incoming = await operators.reserveResponsibility({
      operatorAccountId: other,
      subjectAccountId: operatorId,
      key: key(),
    });
    const context = await ctx(operatorId);
    const results = await Promise.allSettled([
      operators.reserveResponsibility({ operatorAccountId: operatorId, subjectAccountId: subjectId, key: key() }),
      mutation === 'delete'
        ? lifecycle.tombstone(context, { accountId: operatorId, key: key() })
        : operators.recordOperatorRelation({
            subjectAccountId: operatorId,
            operatorAccountId: other,
            reservationId: incoming.value.reservationId,
            expectedOperatorAccountId: null,
            expectedVersion: '0',
            key: key(),
          }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const state = await row(operatorId);
    const held = await operators.responsibilityPage({ operatorAccountId: operatorId, limit: 10 });
    expect(held.operators.length > 0 && (state!.state === 'deleted' || state!.operatorAccountId !== null)).toBe(false);
  }
});

test('operator transfer changes responsibility without inheriting resource grants', async () => {
  const old = await person();
  const next = await person();
  const { subjectId, reservationId, relation } = await automate(old);
  const receipt = await approval(old, old, subjectId);
  const reserved = await operators.reserveResponsibility({
    operatorAccountId: next,
    subjectAccountId: subjectId,
    key: key(),
  });
  const before = (
    await pool.query(
      'SELECT * FROM access.resource_grant WHERE route=$1 AND resource_id=$2 ORDER BY subject_id,action',
      [routeOf(subjectId), subjectId],
    )
  ).rows;
  const input = {
    subjectAccountId: subjectId,
    expectedOperatorAccountId: old,
    expectedVersion: relation.version,
    operatorAccountId: next,
    reservationId: reserved.value.reservationId,
    key: key(),
  };
  const transferred = await operators.recordOperatorRelation(input);
  expect(transferred.value).toMatchObject({ operatorAccountId: next, subjectAccountId: subjectId, version: '2' });
  expect(await operators.recordOperatorRelation(input)).toEqual({ ...transferred, replayed: true });
  await deny(operators.recordOperatorRelation({ ...input, key: key() }));
  await deny(consume(old, old, subjectId, receipt.value.receiptId));
  await deny(approval(old, old, subjectId));
  expect((await approval(next, next, subjectId)).value.operatorAccountId).toBe(next);
  expect(
    (
      await pool.query(
        'SELECT * FROM access.resource_grant WHERE route=$1 AND resource_id=$2 ORDER BY subject_id,action',
        [routeOf(subjectId), subjectId],
      )
    ).rows,
  ).toEqual(before);
  await operators.releaseResponsibility({
    operatorAccountId: old,
    subjectAccountId: subjectId,
    reservationId,
    key: key(),
  });
  expect((await operators.deletionEligibility(old)).safe).toBe(true);
  await lifecycle.tombstone(await ctx(subjectId), { accountId: subjectId, key: key() });
  await operators.retireResponsibility({
    operatorAccountId: next,
    subjectAccountId: subjectId,
    reservationId: reserved.value.reservationId,
    key: key(),
  });
  await operators.releaseResponsibility({
    operatorAccountId: next,
    subjectAccountId: subjectId,
    reservationId: reserved.value.reservationId,
    key: key(),
  });
  expect((await operators.deletionEligibility(next)).safe).toBe(true);
});

test('operator authorization receipts bind the real human and automated subject', async () => {
  const human = await person();
  const { subjectId } = await automate(human);
  const other = await automate(human);
  const first = await approval(human, human, subjectId);
  const id = first.value.receiptId;
  await deny(consume(human, human, subjectId, newId(routeOf(human)!)));
  await deny(consume(human, human, other.subjectId, id));
  await deny(consume(human, human, subjectId, id, 'credential-management'));
  const context = await ctx(human);
  await deny(
    operators.consumeOpening(
      { ...context, actor: { ...context.actor, clientId: 'another-client' } },
      { operatorAccountId: human, subjectAccountId: subjectId, receiptId: id, purpose: 'session', key: key() },
    ),
  );
  await deny(
    operators.consumeOpening(await ctx(human, ['account:manage']), {
      operatorAccountId: human,
      subjectAccountId: subjectId,
      receiptId: id,
      purpose: 'session',
      key: key(),
    }),
  );
  const consumption = {
    operatorAccountId: human,
    subjectAccountId: subjectId,
    receiptId: id,
    purpose: 'session' as const,
    key: key(),
  };
  const consumed = await operators.consumeOpening(context, consumption);
  expect(consumed.value).toMatchObject({
    subjectAccountId: subjectId,
    actingHumanId: human,
    operatorAccountId: human,
    clientId: context.actor.clientId,
    scopes: context.actor.scopes,
    purpose: 'session',
  });
  await deny(operators.consumeOpening(context, consumption));
  await deny(consume(human, human, subjectId, id));
  const concurrent = await approval(human, human, subjectId);
  const attempts = await Promise.allSettled([
    consume(human, human, subjectId, concurrent.value.receiptId),
    consume(human, human, subjectId, concurrent.value.receiptId),
  ]);
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const expired = await approval(human, human, subjectId);
  await pool.query(
    "UPDATE access.operator_opening_receipt SET expires_at=clock_timestamp()-interval '1 second' WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3",
    [routeOf(human), human, expired.value.receiptId],
  );
  await deny(consume(human, human, subjectId, expired.value.receiptId));
  const epoch = await approval(human, human, subjectId);
  await internal.raiseFence({ accountId: subjectId, key: key() });
  await deny(consume(human, human, subjectId, epoch.value.receiptId));
  const credentials = await approval(human, human, other.subjectId, 'credential-management');
  expect(
    (await consume(human, human, other.subjectId, credentials.value.receiptId, 'credential-management')).value.purpose,
  ).toBe('credential-management');
  const humanEpoch = await approval(human, human, other.subjectId);
  await internal.raiseFence({ accountId: human, key: key() });
  await deny(consume(human, human, other.subjectId, humanEpoch.value.receiptId));
  expect(
    (
      await pool.query('SELECT count(*)::int AS count FROM core.outbox WHERE partition_no=$1 AND subject=$2', [
        partitionOf(routeOf(human)!),
        human,
      ])
    ).rows[0].count,
  ).toBeGreaterThan(0);
});

test('unknown actions, missing evidence and delayed preparation fail closed through the actual executor seam', async () => {
  const human = await person();
  const { subjectId } = await automate(human);
  const input = { operatorAccountId: human, subjectAccountId: subjectId, purpose: 'session' as const, key: key() };
  const missing = createAccess({ actions: new Map(), accountEvidence: (_actor, context) => context.account });
  const unavailable = createOperatorCommands({ pool, access: missing, actions, managementAction: 'account:manage' });
  await deny(unavailable.authorizeOpening(await ctx(human), input));
  await deny(operators.authorizeOpening({ ...(await ctx(human)), account: null }, input));
  let prepares = 0;
  const delayed = createOperatorCommands({
    pool,
    actions,
    managementAction: 'account:manage',
    access: {
      ...access,
      async prepare(actor, action, resource, context) {
        prepares++;
        const evidence = await access.prepare!(actor, action, resource, { ...context, deadline: Date.now() + 1000 });
        await Bun.sleep(1050);
        return evidence;
      },
    },
  });
  await expect(delayed.authorizeOpening(await ctx(human), input)).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(prepares).toBe(1);
  const original = await operators.authorizeOpening(await ctx(human), input);
  await expect(
    operators.authorizeOpening(await ctx(human, [...actions.keys()], 'changed-client'), input),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(original.value.receiptId.length).toBeGreaterThan(0);
});
