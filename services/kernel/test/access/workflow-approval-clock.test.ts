import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CredentialEffectBinding } from '@rezics/auth-contract';
import type { SuspensionValue } from '../../src/access/suspension.ts';
import { createPool } from '../../src/database/pool.ts';
import { createAccess, accessClock } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { readApprovedIdentity, verifiedBearerExpiry } from '../../src/access/approved-identity.ts';
import { createWorkflowApprovals, credentialWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import approvalInsert from '../../src/access/workflow-approvals-insert.sql';
import approvalRead from '../../src/access/workflow-approvals-read.sql';
import approvalConsume from '../../src/access/workflow-approvals-credential-consume.sql';
import { newId, routeOf } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
afterAll(() => pool.end());
const keys = { current: 1, keys: new Map([[1, Buffer.alloc(32, 74)]]) };
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'approval-clock', alg: 'ES256' };
const issuer = 'https://approval-clock.test';
const audience = 'https://api.approval-clock.test';
const actions = new Map(['account:manage', 'account:suspend'].map((action) => [action, { anonymous: false }]));
const context = () => ({ pool, deadline: Date.now() + 10_000 });
const iso = (at: number) => new Date(at).toISOString();

async function fixture() {
  let now = Date.now() + 10_000;
  let afterRead: number | undefined;
  const clock = () => {
    const at = new Date(now);
    if (afterRead !== undefined) {
      now = afterRead;
      afterRead = undefined;
    }
    return at;
  };
  const root = createAccess({
    actions,
    clock,
    auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
  });
  const access = deriveAccess(deriveAccess(root, {}), {});
  expect(accessClock(access)).toBe(clock);
  const id = newId(0x1234);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(id), id],
  );
  for (const resource of [{ route: routeOf(id)!, id }, PLATFORM_RESOURCE]) {
    for (const action of actions.keys())
      await pool.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         VALUES ($1,$2,$3,$4,'(,)',$3)`,
        [resource.route, resource.id, id, action],
      );
  }
  const jwtExpiry = Math.floor(Date.now() / 1000) * 1000 + 300_000;
  const bearer = await new SignJWT({
    client_id: 'web',
    scope: [...actions.keys()].join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime(jwtExpiry / 1000)
    .sign(signing.privateKey);
  const actor = await access.authenticate(bearer, context());
  const approvals = createWorkflowApprovals({ pool, access, actions, referenceKeys: keys });
  const credentials = credentialWorkflowApprovals(approvals);
  const binding: CredentialEffectBinding = {
    subjectAccountId: id,
    actingHumanId: id,
    clientId: actor.clientId,
    scopes: [...actor.scopes],
    purpose: 'set-password',
    operationKey: randomUUID(),
    effectReference: 'auth-owned-stage',
    effectDigest: 'a'.repeat(64),
    credentialRowId: null,
    credentialRowVersion: null,
  };
  return {
    access,
    actor,
    approvals,
    credentials,
    binding,
    bearer,
    jwtExpiry,
    at: () => now,
    set: (at: number) => {
      now = at;
    },
    crossAfterRead: (at: number) => {
      afterRead = at;
    },
    approve: () => credentials.approveCredentialForActor(actor, binding, context()),
  };
}

test('approval read and consumption expire strictly on the injected kernel clock without waiting', async () => {
  const f = await fixture();
  const created = f.at();
  const approval = await f.approve();
  const expires = Date.parse(approval.expiresAt);
  expect(expires).toBe(created + 60_000);
  f.set(expires - 1);
  expect((await readApprovedIdentity(f.access, keys, approval.reference, context())).actor.accountId).toBe(
    f.actor.accountId,
  );
  // Cross the lifetime between identity restoration and the consumption command.
  f.crossAfterRead(expires + 1);
  await expect(
    f.credentials.consumeCredential(approval.reference, f.binding, f.actor, context()),
  ).rejects.toHaveProperty('status', 403);
  for (const at of [expires, expires + 1]) {
    f.set(at);
    await expect(readApprovedIdentity(f.access, keys, approval.reference, context())).rejects.toHaveProperty(
      'status',
      403,
    );
    await expect(
      f.credentials.consumeCredential(approval.reference, f.binding, f.actor, context()),
    ).rejects.toHaveProperty('status', 403);
  }
  const row = await pool.query('SELECT consumed_at FROM access.workflow_approval WHERE actor_id=$1', [
    f.actor.accountId,
  ]);
  expect(row.rows).toEqual([{ consumed_at: null }]);
});

test('an approval can be consumed just before its unchanged lifetime', async () => {
  const f = await fixture();
  const approval = await f.approve();
  f.set(Date.parse(approval.expiresAt) - 1);
  const consumed = await f.credentials.consumeCredential(approval.reference, f.binding, f.actor, context());
  expect(consumed.expiresAt).toBeDefined();
  const row = await pool.query('SELECT consumed_at FROM access.workflow_approval WHERE actor_id=$1', [
    f.actor.accountId,
  ]);
  expect(new Date(row.rows[0].consumed_at).getTime()).toBe(f.at());
});

test('bearer expiry caps the lifetime and is checked on the Access clock', async () => {
  const f = await fixture();
  f.set(f.jwtExpiry - 30_000);
  const approval = await f.approve();
  expect(Date.parse(approval.expiresAt)).toBe(f.jwtExpiry);
  expect(verifiedBearerExpiry(f.access, f.actor, context())).toBe(f.jwtExpiry);
  f.set(f.jwtExpiry + 1);
  expect(() => verifiedBearerExpiry(f.access, f.actor, context())).toThrow();
  await expect(readApprovedIdentity(f.access, keys, approval.reference, context())).rejects.toHaveProperty(
    'status',
    403,
  );
  await expect(f.approve()).rejects.toHaveProperty('status', 403);
});

test('approval SQL uses evaluation T even when both lifetimes precede database time', async () => {
  const at = Date.now() - 3_600_000;
  const id = newId(0x2345);
  const input = { route: routeOf(id)!, approval_id: id };
  const [row] = await approvalInsert.run(pool, {
    ...input,
    actor_id: id,
    client_id: 'web',
    scopes: ['account:manage'],
    requested_by: null,
    authn_epoch: 1,
    operation_key: randomUUID(),
    operation: { kind: 'credential' },
    digest: 'b'.repeat(64),
    at: iso(at),
    jwt_expires_at: iso(at + 30_000),
    evidence_expires_at: iso(Date.now() + 10_000),
    transaction_id: randomUUID(),
  });
  expect(Date.parse(row!.expiresAt)).toBe(at + 30_000);
  expect(await approvalRead.run(pool, { ...input, at: iso(at + 29_999) })).not.toBeNull();
  expect(await approvalRead.run(pool, { ...input, at: iso(at + 30_000) })).toBeNull();
  const consume = (time: number) =>
    approvalConsume.run(pool, {
      ...input,
      digest: row!.digest,
      at: iso(time),
      transaction_id: randomUUID(),
    });
  expect(await consume(at + 30_000)).toHaveLength(0);
  expect(await consume(at + 29_999)).toHaveLength(1);
});

test('fence-operator suspension records the injected T in its committed continuation', async () => {
  const f = await fixture();
  const target = newId(0x5678);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(target), target],
  );
  const operation = { kind: 'fence-operator' as const, accountId: target, authorization: 'bound-input' };
  const operationKey = randomUUID();
  const approval = await f.approvals.approve(f.bearer, { operationKey, operation }, context());
  f.set(f.at() + 20_000);
  const request = await f.approvals.resolve(approval.reference, operation, context());
  const suspend = (request as typeof request & { suspendOperator(): Promise<SuspensionValue> }).suspendOperator;
  expect((await suspend()).state).toBe('suspended');
  const row = await pool.query(
    'SELECT created_at FROM access.committed_continuation WHERE route=$1 AND account_id=$2 AND operation_key=$3',
    [routeOf(target), target, operationKey],
  );
  expect(row.rows).toHaveLength(1);
  expect(new Date(row.rows[0].created_at).getTime()).toBe(f.at());
});
