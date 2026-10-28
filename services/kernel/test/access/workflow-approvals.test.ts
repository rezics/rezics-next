import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccountOperation } from '@rezics/auth';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { LIFECYCLE_ACTIONS, createLifecycleCommands } from '../../src/access/lifecycle.ts';
import {
  createWorkflowApprovals,
  workflowApprovalBinding,
  sweepWorkflowApprovals,
} from '../../src/access/workflow-approvals.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { seal, unseal } from '../../src/tokens/seal.ts';
import { accessCheck } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const admin = createPool(url);
const keys = { current: 1, keys: new Map([[1, Buffer.alloc(32, 73)]]) };
const issuer = 'https://approval.test';
const audience = 'https://api.approval.test';
const actions = new Map([...LIFECYCLE_ACTIONS, ['account:delegate', { anonymous: false }]]);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'approval-test', alg: 'ES256' };
const auth = {
  issuer,
  audience,
  jwksUrl: `${issuer}/jwks`,
  fetch: async () => Response.json({ keys: [jwk] }),
};
const context = () => ({ pool, deadline: Date.now() + 5000 });
const access = () => createAccess({ actions, auth });
const build = (native = access()) => createWorkflowApprovals({ pool, access: native, actions, referenceKeys: keys });
const denied = async (work: Promise<unknown>) => expect(work).rejects.toThrow();
async function token(id: string, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: id,
    client_id: 'web',
    scope: 'account:update account:delete organization:membership account:delegate',
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(signing.privateKey);
}
async function fixture() {
  const actor = newId(0x1234);
  const target = newId(0x5678);
  for (const id of [actor, target]) {
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
      VALUES ($1,$2,'actor','active',$2,true)`,
      [routeOf(id), id],
    );
  }
  for (const action of ['account:update', 'account:delete', 'organization:membership']) {
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'(,)',$3)`,
      [routeOf(target), target, actor, action],
    );
  }
  const operation: AccountOperation = {
    kind: 'rename',
    accountId: target,
    handle: 'next',
    expectedHandle: null,
    authorization: 'bound-input',
  };
  return { actor, target, operation, bearer: await token(actor), operationKey: `logical-${actor}` };
}
async function managedDeleteApproval(options: { directDelete?: boolean } = {}) {
  const f = await fixture();
  const operator = newId(0x2468);
  await admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(operator), operator],
  );
  await admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(f.target),
    f.target,
    operator,
  ]);
  if (!options.directDelete)
    await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3', [
      routeOf(f.target),
      f.target,
      'account:delete',
    ]);
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:manage','(,)',$3)`,
    [routeOf(operator), operator, f.actor],
  );
  const native = access();
  const approvals = build(native);
  const deletion: AccountOperation = { kind: 'delete', accountId: f.target, authorization: 'input' };
  const bearer = await token(f.actor, { scope: 'account:delete account:manage' });
  const approved = await approvals.approve(
    bearer,
    { operationKey: `managed-delete-${f.actor}`, operation: deletion },
    context(),
  );
  return { ...f, operator, native, approvals, deletion, approved, bearer };
}
async function tombstoneThroughApproval(value: Awaited<ReturnType<typeof managedDeleteApproval>>) {
  const request = await value.approvals.resolve(value.approved.reference, value.deletion, context());
  const binding = workflowApprovalBinding(request)!;
  await createLifecycleCommands({ pool, access: value.native }).tombstone(request, {
    accountId: value.target,
    key: `${binding.commandKeyPrefix}:tombstone`,
  });
}
beforeAll(async () => {
  await admin.query('SELECT 1 FROM access.account LIMIT 1');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

test('native approval authenticates, persists only bounded claims and resolves after Access restart', async () => {
  const f = await fixture();
  const a = await build().approve(f.bearer, f, context());
  const native = access();
  const restarted = build(native);
  const resolved = await restarted.resolve(a.reference, f.operation, context());
  expect(resolved.actor.accountId).toBe(f.actor);
  const check = await accessCheck(
    native,
    resolved.actor,
    'account:update',
    { route: routeOf(f.target)!, id: f.target },
    context(),
  );
  expect(await check(pool)).toBe(true);
  const copy = await accessCheck(
    native,
    { ...resolved.actor },
    'account:update',
    { route: routeOf(f.target)!, id: f.target },
    context(),
  );
  expect(await copy(pool)).toBe(false);
  const row = await admin.query('SELECT row_to_json(a) AS value FROM access.workflow_approval a WHERE route=$1', [
    routeOf(f.actor),
  ]);
  expect(JSON.stringify(row.rows)).not.toContain(f.bearer);
  expect(JSON.stringify(row.rows)).not.toContain('privateKey');
  expect(await restarted.resolveForCaller(f.bearer, a.reference, f.operation, context())).toHaveProperty(
    'actor.accountId',
    f.actor,
  );
});

test('wrong operation, forged reference, caller, client, claims and unavailable evidence deny', async () => {
  const f = await fixture();
  const approvals = build();
  const a = await approvals.approve(f.bearer, f, context());
  for (const operation of [
    { ...f.operation, handle: 'substitute' },
    { ...f.operation, accountId: f.actor },
    { ...f.operation, unexpected: 'other-purpose' },
    { ...f.operation, kind: 'unknown' },
    null,
  ])
    await denied(approvals.resolve(a.reference, operation as AccountOperation, context()));
  for (const reference of ['garbage', `${a.reference}x`, f.bearer])
    await denied(approvals.resolve(reference, f.operation, context()));
  await denied(approvals.resolveForCaller(await token(f.target), a.reference, f.operation, context()));
  await denied(
    approvals.resolveForCaller(await token(f.actor, { client_id: 'other' }), a.reference, f.operation, context()),
  );
  await denied(approvals.approve('forged', f, context()));
  await denied(
    approvals.resolveForCaller(await token(f.actor, { scope: 'account:delete' }), a.reference, f.operation, context()),
  );
  await denied(approvals.approve(await token(f.actor, { scope: 'account:delete' }), f, context()));
  await denied(build(createAccess({ actions: new Map(), auth })).resolve(a.reference, f.operation, context()));
  await denied(approvals.resolve(a.reference, f.operation, { pool: admin, deadline: Date.now() + 5000 }));
});

for (const fact of ['grant', 'denial', 'floor', 'suspended', 'deleted', 'fence'] as const) {
  test(`resolution rechecks ${fact} before any receipt disclosure`, async () => {
    const f = await fixture();
    const approvals = build();
    const a = await approvals.approve(f.bearer, f, context());
    if (fact === 'grant')
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        routeOf(f.target),
        f.target,
      ]);
    else if (fact === 'denial')
      await admin.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,'account:update','resource','(,)',$3)`,
        [routeOf(f.target), f.target, f.actor],
      );
    else
      await admin.query(
        `UPDATE access.account SET ${fact === 'floor' ? 'minimum_authn_epoch=2' : fact === 'fence' ? 'authn_fenced=true' : `state='${fact}'`} WHERE route=$1 AND account_id=$2`,
        [routeOf(f.actor), f.actor],
      );
    await denied(build().resolve(a.reference, f.operation, context()));
  });
}

test('approval uses the verified original expiry and remains expired across restart before GC', async () => {
  const f = await fixture();
  const exp = Math.floor(Date.now() / 1000) + 2;
  const a = await build().approve(await token(f.actor, { iat: exp - 299, exp, auth_time: exp - 299 }), f, context());
  expect(Date.parse(a.expiresAt)).toBeLessThanOrEqual(exp * 1000);
  expect(Date.parse(a.expiresAt)).toBeGreaterThan(exp * 1000 - 1000);
  await Bun.sleep(Math.max(0, exp * 1000 - Date.now()));
  await denied(build().resolve(a.reference, f.operation, context()));
  expect(
    (
      await admin.query('SELECT count(*)::int AS n FROM access.workflow_approval WHERE route=$1 AND actor_id=$2', [
        routeOf(f.actor),
        f.actor,
      ])
    ).rows[0].n,
  ).toBe(1);
});

test('fresh authenticated approval keeps one logical digest and stable native step receipt across attempts', async () => {
  const f = await fixture();
  const native = access();
  const approvals = build(native);
  const a = await approvals.approve(f.bearer, f, context());
  const firstContext = await approvals.resolve(a.reference, f.operation, context());
  const binding = workflowApprovalBinding(firstContext)!;
  expect(binding.operationKey).toBe(f.operationKey);
  expect(binding.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(workflowApprovalBinding({ ...firstContext })).toBeUndefined();
  const commands = createLifecycleCommands({ pool, access: native });
  const input = {
    accountId: f.target,
    key: `${binding.commandKeyPrefix}:update-profile`,
    patch: { displayName: 'next' },
  };
  const first = await commands.updateAccount(firstContext, input);
  expect(first.replayed).toBe(false);
  const next = await approvals.approve(await token(f.actor), f, context());
  expect(next.reference).not.toBe(a.reference);
  const secondContext = await approvals.resolve(next.reference, f.operation, context());
  expect(workflowApprovalBinding(secondContext)).toEqual(binding);
  const replay = await commands.updateAccount(secondContext, input);
  expect(replay.replayed).toBe(true);
  expect(replay.transactionId).toBe(first.transactionId);
  await denied(
    approvals.approve(
      f.bearer,
      { ...f, operation: { ...f.operation, handle: 'different' } as AccountOperation },
      context(),
    ),
  );
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    routeOf(f.target),
    f.target,
  ]);
  await denied(approvals.resolve(a.reference, f.operation, context()));
  // A context resolved before the revocation cannot disclose the native receipt.
  await denied(commands.updateAccount(secondContext, input));
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:update','(,)',$3)`,
    [routeOf(f.target), f.target, f.actor],
  );
  const restored = await approvals.resolve(a.reference, f.operation, context());
  expect((await commands.updateAccount(restored, input)).transactionId).toBe(first.transactionId);
});

for (const fact of ['assignment', 'principal-grant', 'principal-state', 'provenance'] as const) {
  test(`delegated resolution rechecks current ${fact}`, async () => {
    const f = await fixture();
    const principal = newId(0x3456);
    const requestId = newId(0x3456);
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
      VALUES ($1,$2,'actor','active',$2,true)`,
      [routeOf(principal), principal],
    );
    await admin.query(
      `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,creator_principal_id,valid,transaction_id)
      VALUES ($1,$2,$3,$4,$2,'(,)',$3)`,
      [routeOf(principal), principal, requestId, f.actor],
    );
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,'account:update','(,)',$3)`,
      [routeOf(f.target), f.target, principal],
    );
    const delegated = await token(f.actor, { requested_by: `urn:rezics:request:${principal}:${requestId}` });
    const approvals = build();
    const a = await approvals.approve(delegated, f, context());
    expect((await build().resolve(a.reference, f.operation, context())).actor.requestedBy).not.toBeNull();
    await denied(approvals.resolveForCaller(f.bearer, a.reference, f.operation, context()));
    if (fact === 'assignment')
      await admin.query(
        `UPDATE access.principal_assignment SET revoked_at=transaction_timestamp(), valid=valid * tstzrange(NULL,transaction_timestamp(),'[)') WHERE route=$1 AND principal_id=$2 AND request_id=$3`,
        [routeOf(principal), principal, requestId],
      );
    if (fact === 'principal-grant')
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        routeOf(f.target),
        f.target,
        principal,
      ]);
    if (fact === 'principal-state')
      await admin.query(`UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2`, [
        routeOf(principal),
        principal,
      ]);
    if (fact === 'provenance')
      await admin.query(
        'DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
        [routeOf(principal), principal, requestId],
      );
    await denied(build().resolve(a.reference, f.operation, context()));
  });
}

test('scope ceiling is immutable; later grants and bearer JSON never expand stored claims', async () => {
  const f = await fixture();
  const bearer = await token(f.actor, { scope: 'account:update' });
  const approvals = build();
  const a = await approvals.approve(
    bearer,
    { ...f, operation: { ...f.operation, authorization: bearer } as AccountOperation },
    context(),
  );
  const resolved = await approvals.resolve(a.reference, f.operation, context());
  expect(resolved.actor.scopes).toEqual(['account:update']);
  const serialized = JSON.stringify(
    (
      await admin.query('SELECT row_to_json(a) FROM access.workflow_approval a WHERE route=$1 AND actor_id=$2', [
        routeOf(f.actor),
        f.actor,
      ])
    ).rows,
  );
  expect(serialized).not.toContain(bearer);
  await denied(
    admin.query(`UPDATE access.workflow_approval SET scopes=ARRAY['account:delete'] WHERE route=$1 AND actor_id=$2`, [
      routeOf(f.actor),
      f.actor,
    ]),
  );
  await denied(
    approvals.resolve(a.reference, { kind: 'delete', accountId: f.target, authorization: a.reference }, context()),
  );
});

test('native mappings require action grants for rename, delete and membership; other adapters fail closed', async () => {
  const f = await fixture();
  const approvals = build();
  const deletion: AccountOperation = { kind: 'delete', accountId: f.target, authorization: 'input' };
  const d = await approvals.approve(f.bearer, { operationKey: 'delete', operation: deletion }, context());
  expect(await approvals.resolve(d.reference, deletion, context())).toHaveProperty('actor.accountId', f.actor);
  const organization = newId(0x789a);
  await admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    VALUES ($1,$2,'organization','active',$2,true)`,
    [routeOf(organization), organization],
  );
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'organization:membership','(,)',$3)`,
    [routeOf(organization), organization, f.actor],
  );
  const membership: AccountOperation = {
    kind: 'membership',
    organizationId: organization,
    memberAccountId: f.target,
    role: 'member',
    authorization: 'input',
  };
  const m = await approvals.approve(f.bearer, { operationKey: 'membership', operation: membership }, context());
  expect(await approvals.resolve(m.reference, membership, context())).toHaveProperty('actor.accountId', f.actor);
  for (const kind of ['automated', 'revoke', 'consent', 'client-reduction', 'opening', 'unknown']) {
    await denied(
      approvals.approve(f.bearer, { operationKey: 'unavailable', operation: { kind } as AccountOperation }, context()),
    );
  }
});

test('a delete approval for an automated account follows its current operator', async () => {
  const f = await fixture();
  const operator = newId(0x2468);
  const next = newId(0x3579);
  for (const id of [operator, next]) {
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
      VALUES ($1,$2,'actor','active',$2,true)`,
      [routeOf(id), id],
    );
  }
  await admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(f.target),
    f.target,
    operator,
  ]);
  await admin.query(`DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2`, [
    routeOf(f.target),
    f.target,
  ]);
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:manage','(,)',$3)`,
    [routeOf(operator), operator, f.actor],
  );
  const approvals = build();
  const bearer = await token(f.actor, { scope: 'account:delete account:manage' });
  const deletion: AccountOperation = { kind: 'delete', accountId: f.target, authorization: 'input' };
  const approved = await approvals.approve(bearer, { operationKey: 'managed-delete', operation: deletion }, context());
  expect(await approvals.resolve(approved.reference, deletion, context())).toHaveProperty('actor.accountId', f.actor);
  await admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(f.target),
    f.target,
    next,
  ]);
  await denied(approvals.resolve(approved.reference, deletion, context()));
  await denied(approvals.approve(bearer, { operationKey: 'moved-delete', operation: deletion }, context()));
});

test('a delete approval keeps its own tombstone operator basis after deletion commits', async () => {
  const f = await managedDeleteApproval();
  await tombstoneThroughApproval(f);
  expect(
    await admin.query('SELECT state,operator_account_id FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(f.target),
      f.target,
    ]),
  ).toMatchObject({ rows: [{ state: 'deleted', operator_account_id: null }] });
  expect(await f.approvals.resolve(f.approved.reference, f.deletion, context())).toHaveProperty(
    'actor.accountId',
    f.actor,
  );
});

test('a delete approval rechecks management of its tombstone operator at resolution time', async () => {
  const f = await managedDeleteApproval();
  await tombstoneThroughApproval(f);
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    routeOf(f.operator),
    f.operator,
    f.actor,
  ]);
  await denied(f.approvals.resolve(f.approved.reference, f.deletion, context()));
});

test('a tombstone from another transaction keeps the delete approval fallback', async () => {
  const f = await managedDeleteApproval({ directDelete: true });
  const native = access();
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:delete','(,)',$3)`,
    [routeOf(f.target), f.target, f.target],
  );
  const subject = await native.authenticate(await token(f.target, { scope: 'account:delete' }), context());
  await createLifecycleCommands({ pool, access: native }).tombstone(
    { actor: subject, deadline: Date.now() + 5000 },
    { accountId: f.target, key: `external-delete-${f.target}` },
  );
  await denied(f.approvals.resolve(f.approved.reference, f.deletion, context()));
});

test('expiry sweep is bounded and cannot revive an expired approval', async () => {
  const f = await fixture();
  const a = await build().approve(f.bearer, f, context());
  for (const limit of [0, 1001, 1.5, NaN]) await denied(sweepWorkflowApprovals(pool, routeOf(f.actor)!, limit));
  expect(await sweepWorkflowApprovals(pool, routeOf(f.actor)!, 1)).toBeLessThanOrEqual(1);
  expect(await build().resolve(a.reference, f.operation, context())).toHaveProperty('actor.accountId', f.actor);
});

test('native approval proof, reference purpose, integrity key and all original row claims are required', async () => {
  const f = await fixture();
  const approvals = build();
  const a = await approvals.approve(f.bearer, f, context());
  const locator = unseal(keys, 'access.workflow-approval.v1', a.reference) as {
    route: number;
    id: string;
    binding: string;
  };
  for (const reference of [
    seal(keys, 'wrong-purpose', locator),
    seal(keys, 'access.workflow-approval.v1', { ...locator, binding: '0'.repeat(64) }),
    seal(keys, 'access.workflow-approval.v1', { ...locator, id: newId(locator.route) }),
    seal({ current: 2, keys: new Map([[2, Buffer.alloc(32, 74)]]) }, 'access.workflow-approval.v1', locator),
  ])
    await denied(approvals.resolve(reference, f.operation, context()));
  await admin.query(
    `DELETE FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND command_kind='access.workflow-approval.create' AND idempotency_key=$3`,
    [locator.route >>> 4, f.actor, `${locator.route}:${locator.id}`],
  );
  await denied(build().resolve(a.reference, f.operation, context()));
});
