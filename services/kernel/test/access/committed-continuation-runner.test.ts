import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import {
  ContinuationDeniedError,
  continuationEntryDigest,
  createCommittedContinuations,
  type ContinuationView,
} from '../../src/access/committed-continuations.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createAccess as createAuthenticatedAccess } from '../../src/access/index.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { ActionCatalogue } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const facts = new Pool({ connectionString: url });
const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const actions: ActionCatalogue = new Map([
  ...LIFECYCLE_ACTIONS,
  ['account:manage', { anonymous: false }],
  ['account:suspend', { anonymous: false }],
]);
const access = admittedAccess({ actions });
const operators = createOperatorCommands({ pool, access, actions, managementAction: 'account:manage' });
const lifecycle = createLifecycleCommands({ pool, access });
const proofs = new Map<
  object,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(72),
  provisioningEvidence: async (proof) => proofs.get(proof as object) ?? null,
  recoveryEvidence: async () => null,
});
let frozen: Date | null = null;
const clock = () => frozen ?? new Date();
const continuations = createCommittedContinuations({ pool, access, referenceKeys, clock, pageSize: 2 });

const pair = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'continuation-runner' };
const issuer = 'https://continuation-runner.test';
const governance = createAuthenticatedAccess({
  actions: new Map(['account:suspend', 'account:reinstate'].map((name) => [name, { anonymous: false }])),
  auth: { issuer, audience: issuer, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
});
const suspend = createSuspensionCommands({ pool, access: governance, clock: () => new Date() }).suspend;
let governor: string;

let sequence = 0;
const key = () => `continuation-runner-${++sequence}`;
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex');
const row = (id: string) => withConnection(pool, (client) => readAccount(client, routeOf(id)!, id));
const ctx = async (id: string) => ({
  actor: await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30_000 },
    {
      accountId: id,
      clientId: 'verified-client',
      scopes: [...actions.keys()],
      requestedBy: null,
      authnEpoch: 1,
    },
  ),
  account: await row(id),
  deadline: Date.now() + 3000,
});
async function token(accountId: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: accountId,
    client_id: 'test',
    scope: 'account:suspend account:reinstate',
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(pair.privateKey);
}
async function person() {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const handle = `runner_person_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
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
  await internal.claimHandle({ accountId, handle, reservationId: reservation.value.reservationId, key: key() });
  await operators.provisionManagementDefaults({ operatorAccountId: accountId, key: key() });
  return { accountId, handle };
}
async function automate(operatorId: string) {
  const subject = await person();
  const reserved = await operators.reserveResponsibility({
    operatorAccountId: operatorId,
    subjectAccountId: subject.accountId,
    key: key(),
  });
  await operators.recordOperatorRelation({
    subjectAccountId: subject.accountId,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    operatorAccountId: operatorId,
    reservationId: reserved.value.reservationId,
    key: key(),
  });
  return { ...subject, reservationId: reserved.value.reservationId };
}
async function deleteAccount(accountId: string): Promise<ContinuationView> {
  const name = key();
  const continuation = {
    operationKey: name,
    operationDigest: digestOf(name),
    commandKeyPrefix: `wf:${digestOf(`${name}:prefix`)}`,
  };
  await lifecycle.tombstone(await ctx(accountId), { accountId, key: key(), continuation });
  const view = await continuations.read(name, accountId);
  if (!view) throw new Error('The tombstone committed no continuation');
  return view;
}
async function plainAccount(route = 0x7562) {
  const id = newId(route);
  await facts.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(id), id],
  );
  return id;
}
async function operatedBy(count: number, subjectRoute = 0x7562) {
  const operator = await plainAccount();
  const subjects: string[] = [];
  for (let index = 0; index < count; index++) {
    const subject = await plainAccount(subjectRoute);
    const reservation = `00000000-0000-8000-8000-7562${index.toString(16).padStart(8, '0')}`;
    await facts.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$2)`, [
      routeOf(operator),
      operator,
      reservation,
      subject,
    ]);
    await facts.query(
      'UPDATE access.account SET operator_account_id=$1,operator_reservation_id=$2 WHERE route=$3 AND account_id=$4',
      [operator, reservation, routeOf(subject), subject],
    );
    await facts.query('INSERT INTO access.operator_relation_slot VALUES ($1,$2,$3,$4,false,$4)', [
      routeOf(subject),
      subject,
      reservation,
      operator,
    ]);
    subjects.push(subject);
  }
  return { operator, subjects };
}
async function suspended(operator: string) {
  const deadline = Date.now() + 30_000;
  const actor = await governance.authenticate(await token(governor), { pool, deadline });
  const result = await suspend({ pool, actor, deadline }, { accountId: operator, key: randomUUID() });
  return required(
    await continuations.read(result.value.continuationOperationKey!, operator),
    'The suspension committed no continuation',
  );
}
const required = <T>(value: T | null | undefined, description: string): T => {
  if (value == null) throw new Error(description);
  return value;
};
async function completed(accountId: string, operationKey: string) {
  const result = await facts.query<{ step: string; target: string; key: string; receipt_id: string }>(
    `SELECT c.step, c.target, c.key, c.receipt_id
     FROM access.committed_continuation_completion c
     JOIN access.committed_continuation k ON k.route = c.route AND k.continuation_id = c.continuation_id
     WHERE k.route = $1 AND k.operation_key = $2
     ORDER BY c.step, c.target, c.key`,
    [routeOf(accountId), operationKey],
  );
  return result.rows;
}
async function held(operatorId: string, reservationId: string) {
  const result = await facts.query(
    `SELECT 1 FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3 AND purpose='operator'`,
    [routeOf(operatorId), operatorId, reservationId],
  );
  return result.rowCount === 1;
}
async function fenced(ids: string[]) {
  const rows = await Promise.all(ids.map(row));
  return rows.map((account) => account!.fenced);
}
const pastExpiry = (view: ContinuationView) => new Date(Date.parse(view.expiresAt) + 1000);

beforeAll(async () => {
  governor = await plainAccount();
  await bootstrapGovernance(pool, governor);
});
afterAll(async () => {
  frozen = null;
  await pool.end();
  await facts.end();
});

test('a committed deletion continuation runs its own steps through the runner and an operator deletion completes once native subject deletion released its responsibilities', async () => {
  const operator = await person();
  const subject = await automate(operator.accountId);
  await expect(
    lifecycle.tombstone(await ctx(operator.accountId), { accountId: operator.accountId, key: key() }),
  ).rejects.toThrow();
  const view = await deleteAccount(subject.accountId);
  expect(view.allowlist.map((entry) => entry.step)).toEqual([
    'erase-auth-owner',
    'retire-operator',
    'release-operator',
    'redirect-deleted-handle',
  ]);
  expect(await held(operator.accountId, subject.reservationId)).toBe(true);
  await expect(
    lifecycle.tombstone(await ctx(operator.accountId), { accountId: operator.accountId, key: key() }),
  ).rejects.toThrow();

  await continuations.continueCommitted(view.reference);

  expect(await held(operator.accountId, subject.reservationId)).toBe(false);
  expect((await row(subject.accountId))!.state).toBe('deleted');
  expect(await internal.resolveHandle(subject.handle)).toBeNull();
  // Auth erases its own owner and records that step itself.
  expect((await completed(subject.accountId, view.operationKey)).map((item) => item.step)).toEqual([
    'redirect-deleted-handle',
    'release-operator',
    'retire-operator',
  ]);

  const final = await deleteAccount(operator.accountId);
  await continuations.continueCommitted(final.reference);
  expect((await row(operator.accountId))!.state).toBe('deleted');
  expect(await internal.resolveHandle(operator.handle)).toBeNull();
  expect((await completed(operator.accountId, final.operationKey)).map((item) => item.step)).toEqual([
    'redirect-deleted-handle',
  ]);
});

test('a fencing continuation still runs as before and every page and child effect records exactly one completion on the root', async () => {
  const fixture = await operatedBy(3);
  const root = await suspended(fixture.operator);
  expect(await fenced(fixture.subjects)).toEqual([false, false, false]);

  await continuations.continueCommitted(root.reference);

  expect(await fenced([...fixture.subjects, fixture.operator])).toEqual([true, true, true, true]);
  // Page size 2: two pages and three subjects. Auth owns session revocation.
  const recorded = await completed(fixture.operator, root.operationKey);
  expect(recorded.map((item) => item.step).sort()).toEqual([
    'fence',
    'fence',
    'fence',
    'operator-responsibility-page',
    'operator-responsibility-page',
  ]);
  expect(new Set(recorded.map((item) => item.key)).size).toBe(recorded.length);
  const expanded = (await continuations.read(root.operationKey, fixture.operator))!;
  expect(expanded.reference).toBe(root.reference);
  expect(expanded.allowlist).toHaveLength(root.allowlist.length + 4);
  for (const item of recorded) {
    expect(expanded.allowlist).toContainEqual({
      step: item.step,
      target: item.target,
      key: item.key,
      digest: continuationEntryDigest(item),
    });
  }
  const receipts = await facts.query<{ matches: boolean; native: boolean }>(
    `SELECT r.idempotency_key = c.receipt_key AND encode(r.request_digest,'hex') = c.receipt_digest AS matches,
            c.step <> 'fence' OR f.receipt_id = c.receipt_id AS native
     FROM access.committed_continuation_completion c
     LEFT JOIN access.lifecycle_fence_receipt f ON f.receipt_id = c.receipt_id
       AND f.account_id = split_part(c.target, ':', 1)::uuid
     LEFT JOIN core.receipt r ON r.transaction_id = COALESCE(f.transaction_id, c.receipt_id)
     WHERE c.route=$1 AND c.continuation_id=(SELECT continuation_id FROM access.committed_continuation
       WHERE route=$1 AND operation_key=$2)`,
    [routeOf(fixture.operator), root.operationKey],
  );
  expect(receipts.rows).toHaveLength(recorded.length);
  for (const receipt of receipts.rows) expect(receipt).toEqual({ matches: true, native: true });
  const child = expanded.allowlist.find((item) => item.step === 'fence')!;
  const forged = { ...child, target: `${newId(routeOf(fixture.operator)!)}:${newId(routeOf(fixture.operator)!)}` };
  forged.digest = continuationEntryDigest(forged);
  await expect(continuations.authorizeStep(root.reference, forged)).rejects.toBeInstanceOf(ContinuationDeniedError);
  await expect(
    facts.query('UPDATE access.committed_continuation_entry SET digest=$1 WHERE route=$2', [
      'ab'.repeat(32),
      routeOf(fixture.operator),
    ]),
  ).rejects.toThrow('immutable');
});

test('a step presented after the stored expiry is refused and releases nothing', async () => {
  const operator = await person();
  const subject = await automate(operator.accountId);
  const view = await deleteAccount(subject.accountId);
  const retire = view.allowlist.find((entry) => entry.step === 'retire-operator')!;
  frozen = pastExpiry(view);
  try {
    await expect(continuations.authorizeStep(view.reference, retire)).rejects.toBeInstanceOf(ContinuationDeniedError);
    await expect(continuations.continueCommitted(view.reference)).rejects.toBeInstanceOf(ContinuationDeniedError);
  } finally {
    frozen = null;
  }
  expect(await held(operator.accountId, subject.reservationId)).toBe(true);
  expect(await completed(subject.accountId, view.operationKey)).toEqual([]);
  expect((await operators.deletionEligibility(operator.accountId)).safe).toBe(false);

  const fixture = await operatedBy(3);
  const root = await suspended(fixture.operator);
  frozen = pastExpiry(root);
  try {
    await expect(continuations.continueCommitted(root.reference)).rejects.toBeInstanceOf(ContinuationDeniedError);
  } finally {
    frozen = null;
  }
  expect(await fenced(fixture.subjects)).toEqual([false, false, false]);
  expect(await completed(fixture.operator, root.operationKey)).toEqual([]);

  // Positive controls: the same steps run once the clock is back inside the stored expiry.
  await continuations.continueCommitted(view.reference);
  expect(await held(operator.accountId, subject.reservationId)).toBe(false);
  await continuations.continueCommitted(root.reference);
  expect(await fenced(fixture.subjects)).toEqual([true, true, true]);
});

test('an operated account on another route keeps its native fence receipt on the root completion', async () => {
  const fixture = await operatedBy(1, 0x8673);
  const root = await suspended(fixture.operator);
  await continuations.continueCommitted(root.reference);
  const completion = (await completed(fixture.operator, root.operationKey)).find((item) => item.step === 'fence')!;
  expect(routeOf(completion.receipt_id)).toBe(0x8673);
  const receipt = await facts.query(
    'SELECT account_id FROM access.lifecycle_fence_receipt WHERE route=$1 AND receipt_id=$2',
    [0x8673, completion.receipt_id],
  );
  expect(receipt.rows).toEqual([{ account_id: fixture.subjects[0] }]);
  expect((await continuations.read(root.operationKey, fixture.operator))!.allowlist).toContainEqual({
    step: completion.step,
    target: completion.target,
    key: completion.key,
    digest: continuationEntryDigest(completion),
  });
});

test('no step can bypass the expiry checked authorization path', async () => {
  const fixture = await operatedBy(3);
  const root = await suspended(fixture.operator);
  // The first page commits with its two child effects inside the stored expiry.
  const first = await continuations.continueCommittedPage(root.reference);
  expect(first.next).not.toBeNull();
  const before = await completed(fixture.operator, root.operationKey);
  expect(before).toHaveLength(3);
  frozen = pastExpiry(root);
  try {
    await expect(
      continuations.continueCommittedPage(root.reference, first.next!, first.pageKey),
    ).rejects.toBeInstanceOf(ContinuationDeniedError);
    await expect(continuations.continueCommitted(root.reference)).rejects.toBeInstanceOf(ContinuationDeniedError);
  } finally {
    frozen = null;
  }
  expect(await completed(fixture.operator, root.operationKey)).toEqual(before);
  expect((await fenced(fixture.subjects)).filter(Boolean)).toHaveLength(2);

  // An unlisted or altered entry never records a completion.
  const listed = root.allowlist[0]!;
  await expect(continuations.authorizeStep(root.reference, { ...listed, target: randomUUID() })).rejects.toBeInstanceOf(
    ContinuationDeniedError,
  );
  await expect(
    continuations.authorizeStep(root.reference, { ...listed, digest: 'ab'.repeat(32) }),
  ).rejects.toBeInstanceOf(ContinuationDeniedError);
  // The store accepts nothing but its own immutable, route-bound rows.
  const [stored] = before;
  await expect(
    facts.query('UPDATE access.committed_continuation_completion SET key = $1 WHERE route = $2', [
      'other',
      routeOf(fixture.operator),
    ]),
  ).rejects.toThrow('immutable');
  await expect(
    facts.query('DELETE FROM access.committed_continuation_completion WHERE route = $1', [routeOf(fixture.operator)]),
  ).rejects.toThrow('immutable');
  await expect(
    facts.query(
      `INSERT INTO access.committed_continuation_completion(route, continuation_id, step, target, key, digest, receipt_id)
       SELECT route + 1, continuation_id, step, target, key, digest, receipt_id
       FROM access.committed_continuation_completion WHERE receipt_id = $1`,
      [stored!.receipt_id],
    ),
  ).rejects.toThrow();
  expect(await completed(fixture.operator, root.operationKey)).toEqual(before);
});

test('crash and replay record nothing twice', async () => {
  const operator = await person();
  const subject = await automate(operator.accountId);
  const view = await deleteAccount(subject.accountId);
  // A crash after one step was recorded and before its effect ran.
  const retire = view.allowlist.find((entry) => entry.step === 'retire-operator')!;
  const first = await continuations.authorizeStep(view.reference, retire);
  expect(await held(operator.accountId, subject.reservationId)).toBe(true);
  const restarted = createCommittedContinuations({ pool, access, referenceKeys, clock });
  await restarted.continueCommitted(view.reference);
  const done = await completed(subject.accountId, view.operationKey);
  expect(done).toHaveLength(3);
  expect(done.find((item) => item.step === 'retire-operator')!.receipt_id).toBe(first.receiptId);
  await continuations.continueCommitted(view.reference);
  await restarted.authorizeStep(view.reference, retire);
  expect(await completed(subject.accountId, view.operationKey)).toEqual(done);
  expect(await held(operator.accountId, subject.reservationId)).toBe(false);

  const fixture = await operatedBy(3);
  const root = await suspended(fixture.operator);
  const page = await continuations.continueCommittedPage(root.reference);
  const again = await continuations.continueCommittedPage(root.reference);
  expect(again).toEqual(page);
  const afterPage = await completed(fixture.operator, root.operationKey);
  expect(afterPage).toHaveLength(3);
  await restarted.continueCommitted(root.reference);
  await continuations.continueCommitted(root.reference);
  const all = await completed(fixture.operator, root.operationKey);
  expect(all).toHaveLength(5);
  for (const item of afterPage) expect(all).toContainEqual(item);
  expect(await fenced(fixture.subjects)).toEqual([true, true, true]);
  frozen = pastExpiry(view);
  try {
    await expect(restarted.authorizeStep(view.reference, retire)).rejects.toBeInstanceOf(ContinuationDeniedError);
  } finally {
    frozen = null;
  }
  expect(await completed(subject.accountId, view.operationKey)).toEqual(done);
});
