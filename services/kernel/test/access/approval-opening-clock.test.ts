import { afterAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { AccessUnavailableError, createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createWorkflowApprovals, credentialWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { readApprovedIdentity } from '../../src/access/approved-identity.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import approvalInsert from '../../src/access/workflow-approvals-insert.sql';
import openingInsert from '../../src/access/operator-opening-insert.sql';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
afterAll(() => pool.end());
const keys = { current: 1, keys: new Map([[1, Buffer.alloc(32, 79)]]) };
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'approval-opening-clock', alg: 'ES256' };
const issuer = 'https://approval-opening-clock.test';
const actions = new Map(['account:manage', 'account:update'].map((action) => [action, { anonymous: false }]));
const context = () => ({ pool, deadline: Date.now() + 10_000 });
const iso = (at: number) => new Date(at).toISOString();

async function fixture(at = Date.now()) {
  let now = at;
  const root = createAccess({
    actions,
    clock: () => new Date(now),
    auth: { issuer, audience: issuer, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
  });
  const access = deriveAccess(deriveAccess(root, {}), {});
  const human = newId(0x1234);
  const subject = newId(0x5678);
  for (const id of [human, subject])
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
       VALUES ($1,$2,'actor','active',$2,true)`,
      [routeOf(id), id],
    );
  for (const action of actions.keys())
    await pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$2,$3,'(,)',$2)`,
      [routeOf(human), human, action],
    );
  const issuedAt = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({
    client_id: 'web',
    scope: [...actions.keys()].join(' '),
    authn_epoch: 1,
    auth_time: issuedAt,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(human)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(signing.privateKey);
  const actor = await access.authenticate(bearer, context());
  const operators = createOperatorCommands({
    pool,
    access,
    actions,
    managementAction: 'account:manage',
    cursorKeys: keys,
  });
  const reserved = await operators.reserveResponsibility({
    operatorAccountId: human,
    subjectAccountId: subject,
    key: randomUUID(),
  });
  await operators.recordOperatorRelation({
    subjectAccountId: subject,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    operatorAccountId: human,
    reservationId: reserved.value.reservationId,
    key: randomUUID(),
  });
  const approvals = createWorkflowApprovals({ pool, access, actions, referenceKeys: keys });
  const credentials = credentialWorkflowApprovals(approvals);
  const binding = {
    subjectAccountId: human,
    actingHumanId: human,
    clientId: actor.clientId,
    scopes: [...actor.scopes],
    purpose: 'set-password' as const,
    operationKey: randomUUID(),
    effectReference: 'auth-owned-stage',
    effectDigest: 'a'.repeat(64),
    credentialRowId: null,
    credentialRowVersion: null,
  };
  const operation = {
    kind: 'rename' as const,
    accountId: human,
    handle: 'next',
    expectedHandle: null,
    authorization: 'bound-input',
  };
  const input = { operatorAccountId: human, subjectAccountId: subject, purpose: 'session' as const };
  async function openingContext(bounded = context()) {
    return {
      actor: await access.authenticate(bearer, bounded),
      account: await readAccount(pool, routeOf(human)!, human),
      ...bounded,
    };
  }
  return {
    at,
    access,
    actor,
    human,
    subject,
    set: (value: number) => {
      now = value;
    },
    approve: () => approvals.approve(bearer, { operationKey: randomUUID(), operation }, context()),
    approveCredential: () => credentials.approveCredentialForActor(actor, binding, context()),
    readCredential: (reference: string) => readApprovedIdentity(access, keys, reference, context()),
    consumeCredential: (reference: string) => credentials.consumeCredential(reference, binding, actor, context()),
    resolve: (reference: string, bounded = context()) => approvals.resolve(reference, operation, bounded),
    open: async () => operators.authorizeOpening(await openingContext(), { ...input, key: randomUUID() }),
    consume: async (receiptId: string, bounded = context()) =>
      operators.consumeOpening(await openingContext(bounded), { ...input, receiptId, key: randomUUID() }),
  };
}

test('an approval expires when only the kernel clock reaches its expiry', async () => {
  const processNow = Date.now;
  const f = await fixture(Date.now() + 10_000);
  const approval = await f.approveCredential();
  const expires = Date.parse(approval.expiresAt);
  expect(expires).toBe(f.at + 60_000);
  f.set(expires - 1);
  expect((await f.readCredential(approval.reference)).actor.accountId).toBe(f.human);
  for (const at of [expires, expires + 1]) {
    f.set(at);
    await expect(f.readCredential(approval.reference)).rejects.toHaveProperty('status', 403);
    await expect(f.consumeCredential(approval.reference)).rejects.toHaveProperty('status', 403);
  }
  expect(Date.now).toBe(processNow);
  expect(Date.now()).toBeLessThan(expires);
});

test('an operator opening expires when only the kernel clock reaches its expiry', async () => {
  const processNow = Date.now;
  const f = await fixture(Date.now() + 10_000);
  const opening = (await f.open()).value;
  const expires = Date.parse(opening.expiresAt);
  expect(expires).toBe(f.at + 60_000);
  for (const at of [expires, expires + 1]) {
    f.set(at);
    await expect(f.consume(opening.receiptId)).rejects.toHaveProperty('status', 403);
  }
  const row = await pool.query('SELECT consumed_at FROM access.operator_opening_receipt WHERE receipt_id=$1', [
    opening.receiptId,
  ]);
  expect(row.rows).toEqual([{ consumed_at: null }]);
  f.set(expires - 1);
  expect((await f.consume(opening.receiptId)).value.subjectAccountId).toBe(f.subject);
  expect(Date.now).toBe(processNow);
  expect(Date.now()).toBeLessThan(expires);
});

test('process and database time beyond the lifetimes cannot expire live kernel authority', async () => {
  // Both lifetimes already precede the unchanged database clock at issuance.
  const f = await fixture(Date.now() - 3_600_000);
  const approval = await f.approve();
  const opening = (await f.open()).value;
  const database = await pool.query('SELECT clock_timestamp() AS at');
  expect(Date.parse(approval.expiresAt)).toBeLessThan(new Date(database.rows[0].at).getTime());
  expect(Date.parse(opening.expiresAt)).toBeLessThan(new Date(database.rows[0].at).getTime());
  const processAt = Date.now();
  const processClock = spyOn(Date, 'now').mockReturnValue(processAt + 7_200_000);
  try {
    expect((await f.resolve(approval.reference)).actor.accountId).toBe(f.human);
    expect((await f.consume(opening.receiptId)).value.subjectAccountId).toBe(f.subject);
  } finally {
    processClock.mockRestore();
  }
});

test('request and evidence deadlines stay on real and database time while T is independent', async () => {
  const f = await fixture(Date.now() + 3_600_000);
  const approval = await f.approve();
  const opening = (await f.open()).value;
  expect((await f.resolve(approval.reference)).deadline).toBeLessThan(f.at);
  const expired = { pool, deadline: Date.now() - 1 };
  await expect(f.resolve(approval.reference, expired)).rejects.toBeInstanceOf(AccessUnavailableError);
  await expect(f.consume(opening.receiptId, expired)).rejects.toBeInstanceOf(AccessUnavailableError);
  const evidenceContext = context();
  const evidence = await f.access.prepare!(
    f.actor,
    'account:update',
    { route: routeOf(f.human)!, id: f.human },
    evidenceContext,
  );
  expect(
    await f.access.authorize(pool, f.actor, 'account:update', { route: routeOf(f.human)!, id: f.human }, evidence),
  ).toBe(true);
  await Bun.sleep(1100);
  expect(
    await f.access.authorize(pool, f.actor, 'account:update', { route: routeOf(f.human)!, id: f.human }, evidence),
  ).toBe(true);
  const processClock = spyOn(Date, 'now').mockReturnValue(evidenceContext.deadline + 1);
  try {
    await expect(
      f.access.authorize(pool, f.actor, 'account:update', { route: routeOf(f.human)!, id: f.human }, evidence),
    ).rejects.toBeInstanceOf(AccessUnavailableError);
  } finally {
    processClock.mockRestore();
  }

  // SQL evidence guards must use database time even when T is far in the past.
  const at = iso(Date.now() - 3_600_000);
  const evidenceDeadline = iso(Date.now() - 1);
  expect(
    await approvalInsert.run(pool, {
      route: routeOf(f.human)!,
      approval_id: newId(routeOf(f.human)!),
      actor_id: f.human,
      client_id: 'web',
      scopes: ['account:manage'],
      requested_by: null,
      authn_epoch: 1,
      operation_key: randomUUID(),
      operation: { kind: 'credential' },
      digest: 'a'.repeat(64),
      at,
      jwt_expires_at: iso(Date.parse(at) + 60_000),
      evidence_expires_at: evidenceDeadline,
      transaction_id: randomUUID(),
    }),
  ).toHaveLength(0);
  expect(
    await openingInsert.run(pool, {
      route: routeOf(f.human)!,
      operator_id: f.human,
      receipt_id: newId(routeOf(f.human)!),
      subject_id: f.subject,
      human_id: f.human,
      purpose: 'session',
      action: 'account:manage',
      client_id: 'web',
      scopes: [...f.actor.scopes],
      requested_by: '',
      human_epoch: 1,
      human_floor: 1,
      operator_floor: 1,
      subject_floor: 1,
      version: '1',
      reservation_id: randomUUID(),
      at,
      deadline: evidenceDeadline,
      membership_valid: '(,)',
      transaction_id: randomUUID(),
    }),
  ).toHaveLength(0);
});
