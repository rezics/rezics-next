import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { readLifecycleReview } from '../../src/access/lifecycle-review.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createReinstatementCommands } from '../../src/access/reinstatement.ts';
import { createCommittedContinuations } from '../../src/access/committed-continuations.ts';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { readPublicAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount, accountToken } from '../support/admitted-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import type { LifecycleOriginal } from '../../src/access/lifecycle-review-contract.ts';

// Authored for the controller's native campaign. Deliberately UNRUN in this source slice.
const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1; // Foreign preparation and current disclosure must release their checkouts.
const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(76)]]) };
let access: Access;
let kernel: ReturnType<typeof createKernel>;
const context = () => ({ deadline: Date.now() + 15_000 });
const scopes = ['account:suspend', 'account:reinstate'];
beforeAll(() => {
  kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(77),
    receiptKeys: testReceiptKeys(),
    access(config) {
      access = admittedAccess(config);
      return access;
    },
  });
});
afterAll(() => pool.end());
async function person() {
  const id = newId(0x7351);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,display_name,transaction_id,membership_inverse_complete)
    VALUES($1,$2,'actor','active','Private lifecycle target',$2,true)`,
    [routeOf(id), id],
  );
  return id;
}
async function identify(
  id: string,
  grantedScopes = scopes,
  clientId = 'lifecycle-review',
  requestedBy: string | null = null,
) {
  return authenticateAccount(
    access,
    { pool, ...context() },
    { accountId: id, clientId, scopes: grantedScopes, requestedBy },
  );
}
async function governor() {
  const id = await person();
  await pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
    VALUES(0,$1,$2,'platform.governance','(,)',$2)`,
    [GLOBAL_CONTEXT.id, id],
  );
  return { id, actor: await identify(id) };
}
const read = (actor: AccountActor, id: string, original?: LifecycleOriginal, authority = access) =>
  readLifecycleReview(
    { pool, access: authority },
    actor,
    { accountId: id, ...(original ? { original } : {}) },
    context(),
  );
async function suspend(actor: AccountActor, accountId: string, reason = '  private reason\n  ') {
  const original = { operationId: 'account.suspend', key: crypto.randomUUID(), reason } as const;
  const outcome = await createSuspensionCommands({ pool, access, clock: () => new Date() }).suspend(
    { pool, actor, ...context() },
    { accountId, key: original.key, reason },
  );
  return { original, outcome };
}
async function nativeRead(id: string, token: string, original?: LifecycleOriginal) {
  return kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${id}/lifecycleReview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(original ? { original } : {}),
    }),
  );
}

test('Native exact-target private lifecycle review, exact Global-authorized actions and original-intent bounded readback received by the real page without weakening public privacy or treating a receipt as effect completion', async () => {
  const g = await governor();
  const id = await person();
  expect((await read(g.actor, id)).actions).toEqual([{ action: 'account:suspend', operationId: 'account.suspend' }]);
  const { original, outcome } = await suspend(g.actor, id);
  const view = await read(g.actor, id, original);
  expect(view.current).toEqual({
    state: 'suspended',
    minimumAuthnEpoch: outcome.value.minimumAuthnEpoch,
    fenced: true,
  });
  expect(view.actions).toEqual([{ action: 'account:reinstate', operationId: 'account.reinstate' }]);
  expect(view.original).toMatchObject({
    status: 'recorded',
    receiptId: outcome.value.receiptId,
    effects: { state: 'unknown', sessionRevocation: 'unknown', operator: 'complete' },
  });
  const token = await accountToken({ accountId: g.id, clientId: 'lifecycle-review', scopes });
  const response = await nativeRead(id, token, original);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const text = await response.text();
  expect(text).not.toContain(original.reason);
  expect(text).not.toContain(original.key);
  for (const secret of ['requestDigest', 'operationDigest', 'commandKeyPrefix', 'suspensionReason', 'receipt_key'])
    expect(text).not.toContain(secret);
  expect(JSON.parse(text).original.receiptId).toBe(outcome.value.receiptId);
  expect(await readPublicAccount(pool, routeOf(id)!, id)).toBeNull();
  const management = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${id}/management`, { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(management.status).toBe(404);
  const generic = await kernel.handle(
    new Request('http://kernel.test/v1/viewerActions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ resources: [{ type: 'access.account', id }] }),
    }),
  );
  expect(await generic.text()).not.toContain('account.suspend');
});

test('a target, local grant, management relationship or scope cannot replace Global authority; missing and denied share bounded denial', async () => {
  const id = await person();
  const reader = await person();
  const actor = await identify(reader);
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES($1,$2,$3,'account:suspend','(,)',$3)`,
    [routeOf(id), id, reader],
  );
  for (const target of [id, newId(0x7351)])
    await expect(read(actor, target)).rejects.toMatchObject({ code: 'not_found' });
  const token = await accountToken({ accountId: reader, clientId: 'lifecycle-review', scopes });
  for (const target of [id, newId(0x7351)]) {
    const response = await nativeRead(target, token);
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('not_found');
  }
});

test('current scopes and current actor floor are decisive before original receipt disclosure', async () => {
  const g = await governor();
  const id = await person();
  const { original } = await suspend(g.actor, id);
  await expect(read(await identify(g.id, []), id, original)).rejects.toMatchObject({ code: 'not_found' });
  await pool.query(
    `UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2`,
    [routeOf(g.id), g.id],
  );
  await expect(read(g.actor, id, original)).rejects.toMatchObject({ code: 'not_found' });
});

test('lost response is resolved from the exact original native receipt without another command or state reconstruction', async () => {
  const g = await governor();
  const id = await person();
  const { original, outcome } = await suspend(g.actor, id);
  const before = await pool.query(`SELECT count(*)::int AS n FROM core.receipt WHERE partition_no=$1`, [
    partitionOf(routeOf(id)!),
  ]);
  for (let i = 0; i < 2; i++)
    expect((await read(g.actor, id, original)).original).toMatchObject({
      status: 'recorded',
      receiptId: outcome.value.receiptId,
    });
  const after = await pool.query(`SELECT count(*)::int AS n FROM core.receipt WHERE partition_no=$1`, [
    partitionOf(routeOf(id)!),
  ]);
  expect(after.rows[0]).toEqual(before.rows[0]);
  expect((await read(g.actor, id, { ...original, key: crypto.randomUUID() })).original).toEqual({ status: 'unknown' });
});

test('key, operation, exact reason, target, principal and original authenticated client all bind the immutable request digest', async () => {
  const g = await governor();
  const other = await governor();
  const id = await person();
  const { original } = await suspend(g.actor, id);
  for (const input of [
    { ...original, key: crypto.randomUUID() },
    { ...original, reason: original.reason.trim() },
    { ...original, operationId: 'account.reinstate' as const },
  ])
    expect((await read(g.actor, id, input)).original).toEqual({ status: 'unknown' });
  expect((await read(other.actor, id, original)).original).toEqual({ status: 'unknown' });
  expect((await read(await identify(g.id, scopes, 'another-client'), id, original)).original).toEqual({
    status: 'unknown',
  });
  expect((await read(g.actor, await person(), original)).original).toEqual({ status: 'unknown' });
});

test('revoking exact Global authority during final disclosure suppresses even a previously found receipt', async () => {
  const g = await governor();
  const id = await person();
  const { original } = await suspend(g.actor, id);
  let preparations = 0;
  const wrapped = deriveAccess(access, {
    async prepare(...args) {
      if (++preparations === 5)
        await pool.query(`DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2`, [
          GLOBAL_CONTEXT.id,
          g.id,
        ]);
      return access.prepare!(...args);
    },
  });
  await expect(read(g.actor, id, original, wrapped)).rejects.toMatchObject({ code: 'not_found' });
  await expect(read(g.actor, id, original)).rejects.toMatchObject({ code: 'not_found' });
});

test('native source home epoch or active-home changes refuse disclosure rather than reconstructing an original result', async () => {
  const g = await governor();
  const id = await person();
  const { original } = await suspend(g.actor, id);
  const partition = partitionOf(routeOf(id)!);
  let preparations = 0;
  let changed = false;
  const wrapped = deriveAccess(access, {
    async prepare(...args) {
      if (++preparations === 5) {
        await pool.query(`UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1`, [partition]);
        changed = true;
      }
      return access.prepare!(...args);
    },
  });
  try {
    await expect(read(g.actor, id, original, wrapped)).rejects.toMatchObject({ code: 'dependency_unavailable' });
  } finally {
    if (changed) await pool.query(`UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1`, [partition]);
  }
});

test('queue registration and missing operator pages never prove terminal effects; native page and subject receipts are inspected', async () => {
  const g = await governor();
  const id = await person();
  const related = await person();
  const reservation = newId(0x7351);
  await pool.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
    VALUES($1,$2,$3,$4,'operator',$3)`,
    [routeOf(id), id, reservation, related],
  );
  const { original, outcome } = await suspend(g.actor, id);
  const view = await read(g.actor, id, original);
  expect(view.original).toMatchObject({
    status: 'recorded',
    effects: { operator: 'unknown', sessionRevocation: 'unknown', state: 'unknown' },
  });
  const continuations = createCommittedContinuations({ pool, access, referenceKeys });
  const root = await continuations.read(outcome.value.continuationOperationKey!, id);
  expect(root).not.toBeNull();
  // Executes the owned operator runner only in the deferred native test campaign; never from the reader.
  await continuations.continueCommittedPage(root!.reference);
  const after = await read(g.actor, id, original);
  expect(after.original).toMatchObject({
    status: 'recorded',
    effects: { inspectedPages: 1, operator: 'complete', sessionRevocation: 'unknown', state: 'unknown' },
  });
  expect(after.original).toMatchObject({
    effects: { terminalSubjects: 1, operatorPage: { state: 'complete', nextPageKey: null } },
  });
  const authEntry = root!.allowlist.find((entry) => entry.step === 'revoke-auth-sessions')!;
  await continuations.authorizeStep(root!.reference, authEntry);
  expect((await read(g.actor, id, original)).original).toMatchObject({
    status: 'recorded',
    effects: {
      sessionRevocationAuthorization: 'recorded',
      sessionRevocation: 'unknown',
      state: 'unknown',
    },
  });
  // A page's recorded business outcome cannot discharge a child with unavailable completion evidence.
  await pool.query(
    `DELETE FROM access.committed_continuation_completion WHERE route=$1 AND continuation_id=$2 AND step='fence'`,
    [
      routeOf(id),
      (
        await pool.query(
          `SELECT continuation_id FROM access.committed_continuation WHERE route=$1 AND operation_key=$2`,
          [routeOf(id), outcome.value.continuationOperationKey],
        )
      ).rows[0].continuation_id,
    ],
  );
  expect((await read(g.actor, id, original)).original).toMatchObject({
    status: 'recorded',
    effects: {
      operator: 'pending',
      terminalSubjects: 0,
      operatorPage: { state: 'pending' },
      state: 'pending',
    },
  });
});

test('actual positive operator fence and unfence receipts prove owned terminal cases without a foreign cleanup ACK', async () => {
  const g = await governor();
  const operator = await person();
  const subject = await person();
  const reservation = newId(0x7351);
  await pool.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
    VALUES($1,$2,$3,$4,'operator',$3)`,
    [routeOf(operator), operator, reservation, subject],
  );
  await pool.query(
    `UPDATE access.account SET operator_account_id=$1,operator_reservation_id=$2 WHERE route=$3 AND account_id=$4`,
    [operator, reservation, routeOf(subject), subject],
  );
  await pool.query(
    `INSERT INTO access.operator_relation_slot(route,subject_account_id,reservation_id,operator_account_id,terminal,transaction_id)
    VALUES($1,$2,$3,$4,false,$3)`,
    [routeOf(subject), subject, reservation, operator],
  );
  const suspended = await suspend(g.actor, operator);
  const continuations = createCommittedContinuations({ pool, access, referenceKeys });
  const root = (await continuations.read(suspended.outcome.value.continuationOperationKey!, operator))!;
  await continuations.continueCommittedPage(root.reference);
  expect((await read(g.actor, operator, suspended.original)).original).toMatchObject({
    status: 'recorded',
    effects: {
      operator: 'complete',
      terminalSubjects: 1,
      sessionRevocation: 'unknown',
      state: 'unknown',
    },
  });
  const original = { operationId: 'account.reinstate', key: crypto.randomUUID(), reason: 'restored' } as const;
  const restored = await createReinstatementCommands({ pool, access, clock: () => new Date() }).reinstate(
    { pool, actor: g.actor, ...context() },
    { accountId: operator, key: original.key, reason: original.reason },
  );
  const restoring = (await continuations.read(`reinstate:${restored.value.receiptId}`, operator))!;
  expect((await read(g.actor, operator, original)).original).toMatchObject({ effects: { operator: 'unknown' } });
  await continuations.continueCommittedPage(restoring.reference);
  expect((await read(g.actor, operator, original)).original).toMatchObject({
    status: 'recorded',
    effects: {
      operator: 'complete',
      terminalSubjects: 1,
      sessionRevocation: 'not_required',
      accountAgentSynchronization: 'unknown',
      state: 'unknown',
    },
  });
});

test('native reinstatement recorded no-fanout event proves only its own terminal effects and preserves the authentication floor', async () => {
  const g = await governor();
  const id = await person();
  const suspended = await suspend(g.actor, id);
  const original = { operationId: 'account.reinstate', key: crypto.randomUUID(), reason: '  restore  ' } as const;
  const restored = await createReinstatementCommands({ pool, access, clock: () => new Date() }).reinstate(
    { pool, actor: g.actor, ...context() },
    { accountId: id, key: original.key, reason: original.reason },
  );
  const result = await read(g.actor, id, original);
  expect(result.current).toEqual({
    state: 'active',
    minimumAuthnEpoch: suspended.outcome.value.minimumAuthnEpoch,
    fenced: false,
  });
  expect(result.original).toMatchObject({
    status: 'recorded',
    receiptId: restored.value.receiptId,
    effects: {
      state: 'unknown',
      operator: 'complete',
      sessionRevocation: 'not_required',
      accountAgentSynchronization: 'unknown',
    },
  });
});

test('both delegated grants, current principal assignment, native denials and the exact original principal remain necessary', async () => {
  const g = await governor();
  const principal = await person();
  const request = newId(routeOf(principal)!);
  const id = await person();
  await pool.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES($1,$2,$3,$4,'(,)',$3)`,
    [routeOf(principal), principal, request, g.id],
  );
  const delegated = await identify(g.id, scopes, 'lifecycle-review', `urn:rezics:request:${principal}:${request}`);
  await expect(read(delegated, id)).rejects.toMatchObject({ code: 'not_found' });
  await pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
    VALUES(0,$1,$2,'platform.governance','(,)',$2)`,
    [GLOBAL_CONTEXT.id, principal],
  );
  const { original, outcome } = await suspend(delegated, id);
  expect((await read(delegated, id, original)).original).toMatchObject({
    status: 'recorded',
    receiptId: outcome.value.receiptId,
  });
  expect((await read(g.actor, id, original)).original).toEqual({ status: 'unknown' });
  await pool.query(`DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3`, [
    routeOf(principal),
    principal,
    request,
  ]);
  await expect(read(delegated, id, original)).rejects.toMatchObject({ code: 'not_found' });
  await pool.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES(0,$1,$2,'account:suspend','resource','(,)',$2)`,
    [GLOBAL_CONTEXT.id, g.id],
  );
  // Either action permits private target review, but the other action never unlocks this original receipt.
  expect((await read(g.actor, id)).actions).toEqual([
    { action: 'account:reinstate', operationId: 'account.reinstate' },
  ]);
  await expect(read(g.actor, id, original)).rejects.toMatchObject({ code: 'not_found' });
});
