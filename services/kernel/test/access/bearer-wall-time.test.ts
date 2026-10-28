import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createAccess } from '../../src/access/index.ts';
import { readApprovedIdentity, verifiedBearerExpiry } from '../../src/access/approved-identity.ts';
import { rateIdentity } from '../../src/access/write-rate-identity.ts';
import { createWorkflowApprovals, credentialWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
afterAll(() => pool.end());
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'wall-time', alg: 'ES256' };
const issuer = 'https://wall-time.test';
const actions = new Map([['account:manage', { anonymous: false }]]);
const keys = { current: 1, keys: new Map([[1, Buffer.alloc(32, 38)]]) };
const context = () => ({ pool, deadline: Date.now() + 10_000 });
const shift = 720 * 3_600_000;

async function fixture(offset: number, lifetime = 300) {
  let now = Date.now() + offset;
  const clock = () => new Date(now);
  const access = createAccess({
    actions,
    clock,
    auth: { issuer, audience: issuer, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
  });
  const id = newId(0x1234);
  const resource = { route: routeOf(id)!, id };
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,true)`,
    [resource.route, id],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'account:manage','(,)',$2)`,
    [resource.route, id],
  );
  async function sign(extra: Record<string, unknown> = {}) {
    const at = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      aud: issuer,
      sub: id,
      client_id: 'web',
      scope: 'account:manage',
      authn_epoch: 1,
      iat: at,
      exp: at + lifetime,
      auth_time: at,
      amr: ['pwd'],
      ...extra,
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .sign(signing.privateKey);
  }
  // Leave the full one-second lifetime available for the pre-expiry assertions.
  if (lifetime === 1) await Bun.sleep(1000 - (Date.now() % 1000));
  const bearer = await sign();
  const received = context();
  const actor = await access.authenticate(bearer, received);
  async function admit(candidate: AccountActor = actor) {
    const request = context();
    return runCommand(
      pool,
      {
        partition: partitionOf(resource.route),
        clock,
        deadline: request.deadline,
        basis: { actorAccountId: id, clientId: candidate.clientId, requestedBy: candidate.requestedBy },
        authorization: await accessCommandAuthorization(
          access,
          candidate,
          'account:manage',
          resource,
          request,
          () => new Error('Denied'),
        ),
        receipt: { actorAccountId: id, kind: 'wall-time-test', key: randomUUID(), digest: Buffer.alloc(32) },
      },
      async () => ({ value: true, events: [{ type: 'com.rezics.test.admission.v1', data: {} }] }),
    );
  }
  return {
    access,
    actor,
    bearer,
    received,
    resource,
    sign,
    admit,
    clock,
    set: (at: number) => {
      now = at;
    },
  };
}

test('a wall-valid bearer authenticates, authorizes, admits and rate-identifies 720 hours ahead', async () => {
  const f = await fixture(shift);
  const evidence = await f.access.prepare!(f.actor, 'account:manage', f.resource, f.received);
  expect(await f.access.authorize(pool, f.actor, 'account:manage', f.resource, evidence)).toBe(true);
  expect((await f.admit()).value).toBe(true);
  expect(rateIdentity({ ...f.received, actor: f.actor }, 'secret').rateClass).toBe('member');
  expect(verifiedBearerExpiry(f.access, f.actor, f.received)).toBeGreaterThan(Date.now());
});

test('wall-expired bearer is refused at authentication, preparation, authorization, admission and rate identity behind kernel time', async () => {
  const f = await fixture(-shift, 1);
  const expires = verifiedBearerExpiry(f.access, f.actor, f.received);
  const evidence = await f.access.prepare!(f.actor, 'account:manage', f.resource, f.received);
  expect(await f.access.authorize(pool, f.actor, 'account:manage', f.resource, evidence)).toBe(true);
  expect(rateIdentity({ ...f.received, actor: f.actor }, 'secret').rateClass).toBe('new-account');
  expect((await f.admit()).value).toBe(true);
  await Bun.sleep(Math.max(0, expires - Date.now()));
  await expect(f.access.authenticate(f.bearer, context())).rejects.toHaveProperty('status', 401);
  expect(await f.access.prepare!(f.actor, 'account:manage', f.resource, f.received)).toBeNull();
  expect(await f.access.authorize(pool, f.actor, 'account:manage', f.resource, evidence)).toBe(false);
  await expect(f.admit()).rejects.toThrow();
  expect(() => rateIdentity({ ...f.received, actor: f.actor }, 'secret')).toThrow();
  expect(() => verifiedBearerExpiry(f.access, f.actor, f.received)).toThrow();
});

test('a bearer that expires during the actor read is refused on wall time with kernel time behind', async () => {
  const f = await fixture(-shift, 1);
  const expires = verifiedBearerExpiry(f.access, f.actor, f.received);
  const delayed = Object.create(pool) as Pool;
  let reads = 0;
  delayed.query = (async (query: Parameters<Pool['query']>[0]) => {
    const result = await pool.query(query);
    reads++;
    await Bun.sleep(Math.max(0, expires - Date.now()));
    return result;
  }) as Pool['query'];
  await expect(
    f.access.authenticate(f.bearer, { pool: delayed, deadline: Date.now() + 10_000 }),
  ).rejects.toHaveProperty('status', 401);
  expect(reads).toBe(1);
});

test('future wall iat is refused even with kernel time ahead', async () => {
  const f = await fixture(shift);
  const iat = Math.floor(f.clock().getTime() / 1000);
  await expect(
    f.access.authenticate(await f.sign({ iat, exp: iat + 300, auth_time: iat }), context()),
  ).rejects.toHaveProperty('status', 401);
});

test('grant validity and principal assignments still follow the kernel clock', async () => {
  const f = await fixture(shift);
  const at = f.clock().getTime();
  await pool.query(
    `UPDATE access.resource_grant SET valid=tstzrange($3::timestamptz,$4::timestamptz,'[)') WHERE route=$1 AND resource_id=$2`,
    [f.resource.route, f.resource.id, new Date(at - 1000), new Date(at + 1000)],
  );
  const evidence = await f.access.prepare!(f.actor, 'account:manage', f.resource, f.received);
  expect(await f.access.authorize(pool, f.actor, 'account:manage', f.resource, evidence)).toBe(true);
  f.set(at + 1000);
  const ended = await f.access.prepare!(f.actor, 'account:manage', f.resource, f.received);
  expect(await f.access.authorize(pool, f.actor, 'account:manage', f.resource, ended)).toBe(false);
  const principal = newId(0x2345);
  const request = newId(0x2345);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(principal), principal],
  );
  await pool.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,creator_principal_id,valid,issued_valid,transaction_id)
    VALUES ($1,$2,$3,$4,$2,tstzrange($5::timestamptz,$6::timestamptz,'[)'),tstzrange($5::timestamptz,$6::timestamptz,'[)'),$3)`,
    [routeOf(principal), principal, request, f.actor.accountId, new Date(at), new Date(at + 2000)],
  );
  const delegated = await f.sign({ requested_by: `urn:rezics:request:${principal}:${request}` });
  expect((await f.access.authenticate(delegated, context())).requestedBy).toBe(
    `urn:rezics:request:${principal}:${request}`,
  );
  f.set(at + 2000);
  await expect(f.access.authenticate(delegated, context())).rejects.toHaveProperty('status', 401);
});

test('restored approval identities keep kernel expiry across wall passage at every identity check', async () => {
  const f = await fixture(shift, 2);
  const expiry = verifiedBearerExpiry(f.access, f.actor, f.received);
  const approvals = createWorkflowApprovals({ pool, access: f.access, actions, referenceKeys: keys });
  const credentials = credentialWorkflowApprovals(approvals);
  const before = Date.now();
  const approval = await credentials.approveCredentialForActor(
    f.actor,
    {
      subjectAccountId: f.actor.accountId,
      actingHumanId: f.actor.accountId,
      clientId: f.actor.clientId,
      scopes: [...f.actor.scopes],
      purpose: 'set-password',
      operationKey: randomUUID(),
      effectReference: 'stage',
      effectDigest: 'a'.repeat(64),
      credentialRowId: null,
      credentialRowVersion: null,
    },
    context(),
  );
  const after = Date.now();
  const kernelExpiry = Date.parse(approval.expiresAt);
  expect(kernelExpiry).toBeGreaterThanOrEqual(f.clock().getTime() + expiry - after);
  expect(kernelExpiry).toBeLessThanOrEqual(f.clock().getTime() + expiry - before);
  f.set(kernelExpiry - 1);
  const restored = (await readApprovedIdentity(f.access, keys, approval.reference, context())).actor;
  await Bun.sleep(Math.max(0, expiry - Date.now()) + 20);
  expect((await readApprovedIdentity(f.access, keys, approval.reference, context())).actor.accountId).toBe(
    f.actor.accountId,
  );
  const evidence = await f.access.prepare!(restored, 'account:manage', f.resource, context());
  expect(await f.access.authorize(pool, restored, 'account:manage', f.resource, evidence)).toBe(true);
  expect(await f.access.prepare!(restored, 'account:manage', f.resource, context())).not.toBeNull();
  expect((await f.admit(restored)).value).toBe(true);
  expect(rateIdentity({ ...context(), actor: restored }, 'secret').rateClass).toBe('member');
  expect(verifiedBearerExpiry(f.access, restored, context())).toBe(kernelExpiry);
  f.set(kernelExpiry);
  await expect(readApprovedIdentity(f.access, keys, approval.reference, context())).rejects.toHaveProperty(
    'status',
    403,
  );
  expect(await f.access.prepare!(restored, 'account:manage', f.resource, context())).toBeNull();
  expect(await f.access.authorize(pool, restored, 'account:manage', f.resource, evidence)).toBe(false);
  await expect(f.admit(restored)).rejects.toThrow();
  expect(() => rateIdentity({ ...context(), actor: restored }, 'secret')).toThrow();
  expect(() => verifiedBearerExpiry(f.access, restored, context())).toThrow();
});

for (const offset of [shift, -shift]) {
  test(`operator credential opening carries its bearer cap into kernel time at offset ${offset}`, async () => {
    const f = await fixture(offset, 30);
    const subject = newId(0x5678);
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
       VALUES ($1,$2,'actor','active',$2,true)`,
      [routeOf(subject), subject],
    );
    const operators = createOperatorCommands({
      pool,
      access: f.access,
      actions,
      managementAction: 'account:manage',
      cursorKeys: keys,
    });
    const human = f.actor.accountId;
    const reservation = await operators.reserveResponsibility({
      operatorAccountId: human,
      subjectAccountId: subject,
      key: randomUUID(),
    });
    await operators.recordOperatorRelation({
      subjectAccountId: subject,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      operatorAccountId: human,
      reservationId: reservation.value.reservationId,
      key: randomUUID(),
    });
    const binding = {
      subjectAccountId: subject,
      actingHumanId: human,
      clientId: f.actor.clientId,
      scopes: [...f.actor.scopes],
      purpose: 'set-password' as const,
      operationKey: randomUUID(),
      effectReference: 'stage',
      effectDigest: 'b'.repeat(64),
      credentialRowId: null,
      credentialRowVersion: null,
    };
    const openingContext = { ...f.received, actor: f.actor, account: await readAccount(pool, routeOf(human)!, human) };
    const expiry = verifiedBearerExpiry(f.access, f.actor, f.received);
    const before = Date.now();
    const opening = await operators.authorizeOpening(openingContext, {
      operatorAccountId: human,
      subjectAccountId: subject,
      purpose: 'credential-management',
      credential: binding,
      key: randomUUID(),
    });
    const after = Date.now();
    const expires = Date.parse(opening.value.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(f.clock().getTime() + expiry - after);
    expect(expires).toBeLessThanOrEqual(f.clock().getTime() + expiry - before);
    const input = {
      operatorAccountId: human,
      subjectAccountId: subject,
      receiptId: opening.value.receiptId,
      purpose: 'credential-management' as const,
      credential: binding,
      key: randomUUID(),
    };
    f.set(expires);
    await expect(operators.consumeOpening(openingContext, input)).rejects.toHaveProperty('status', 403);
    f.set(expires - 1);
    expect((await operators.consumeOpening(openingContext, input)).value.expiresAt).toBe(
      new Date(expires).toISOString(),
    );
  });
}
