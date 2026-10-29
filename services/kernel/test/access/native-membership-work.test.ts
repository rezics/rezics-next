import { afterAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccountOperation } from '@rezics/auth';
import type { MembershipWorkInput, MembershipWorkResult } from '@rezics/auth/membership-workflows';
import { createPool } from '../../src/database/pool.ts';
import { systemClock } from '../../src/clock.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWorkflowApprovals, workflowApprovalBinding } from '../../src/access/workflow-approvals.ts';
import {
  createAccountsWorkModule,
  createMembershipWorkPorts,
  enqueueMembership,
} from '../../src/access/membership-work.ts';
import { readMembershipWorkConfig } from '../../src/access/membership-work-config.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const client = await createWorkClient(process.env.DATABASE_URL!);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'membership-component', alg: 'ES256' };
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ keys: [jwk] }) });
const issuer = `http://127.0.0.1:${server.port}`;
const keys = { current: 7, keys: new Map([[7, Buffer.alloc(32, 71)]]) };
const env = {
  KERNEL_ROUTE_KEY: Buffer.alloc(32, 59).toString('base64url'),
  KERNEL_WORKFLOW_REFERENCE_KEYS: JSON.stringify({
    current: 7,
    keys: { 7: Buffer.alloc(32, 71).toString('base64url') },
  }),
  AUTH_ISSUER: issuer,
  AUTH_AUDIENCE: 'https://api.membership.test',
  AUTH_JWKS_URL: `${issuer}/jwks`,
};
const context = {
  pool,
  client,
  queues: WORK_QUEUES,
  env,
  clock: systemClock,
  addEffects() {},
  addService() {},
};
const boundary = () => ({ pool, deadline: Date.now() + 10000 });
const caller = createAccess({
  actions: LIFECYCLE_ACTIONS,
  auth: { issuer, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL },
});
const approvals = createWorkflowApprovals({ pool, access: caller, actions: LIFECYCLE_ACTIONS, referenceKeys: keys });
const internal = createLifecycleInternals({
  pool,
  routeKey: Buffer.from(env.KERNEL_ROUTE_KEY, 'base64url'),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const operation = (input: Extract<MembershipWorkInput, { kind: 'membership' }>): AccountOperation => ({
  kind: 'membership',
  organizationId: input.principal.id,
  memberAccountId: input.memberAccountId,
  role: input.role,
  ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
  authorization: input.authorization,
});
// Component fixtures establish domain rows and issue test JWTs. This is not
// ordinary Auth registration, the final API assembly or a website provider.
async function fixture(lifetime = 300) {
  const actor = newId(0x4310),
    member = newId(0x4320),
    group = newId(0x4330);
  for (const id of [actor, member])
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES($1,$2,'actor','active',$2,true)`,
      [routeOf(id), id],
    );
  const held = (
    await internal.reserveCoordination({
      accountId: actor,
      relatedAccountId: group,
      purpose: 'membership',
      key: randomUUID(),
    })
  ).value;
  await internal.createOrganization({
    organizationId: group,
    ownerAccountId: actor,
    ownerReservationId: held.reservationId,
    key: randomUUID(),
  });
  const now = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({
    sub: actor,
    client_id: 'component',
    scope: 'organization:membership',
    authn_epoch: 1,
    iat: now,
    exp: now + lifetime,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(env.AUTH_AUDIENCE)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(signing.privateKey);
  const input: Extract<MembershipWorkInput, { kind: 'membership' }> = {
    kind: 'membership',
    principal: { kind: 'organization', id: group },
    memberAccountId: member,
    role: 'member',
    authorization: 'unresolved',
  };
  async function approve(value = input) {
    const approval = await approvals.approve(
      bearer,
      { operationKey: randomUUID(), operation: operation(value) },
      boundary(),
    );
    return { ...value, authorization: approval.reference };
  }
  return { actor, member, group, bearer, input, approve, expires: (now + lifetime) * 1000 };
}
// Capture registration only. All approval, Access and membership I/O below is
// native; the test does not launch a second worker or simulate database commands.
async function registered() {
  const steps = new Map<string, (...args: any[]) => Promise<any>>();
  let run!: (input: MembershipWorkInput) => Promise<MembershipWorkResult>;
  const step = spyOn(DBOS, 'registerStep').mockImplementation(((fn: any, options: { name: string }) => {
    steps.set(options.name.split('.').at(-1)!, fn);
    return fn;
  }) as never);
  const workflow = spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: any, options: { name: string }) => {
    if (options.name === 'accounts.membership') run = fn;
    return fn;
  }) as never);
  try {
    await createAccountsWorkModule().register(context);
    expect(step.mock.calls.filter((call) => call[1]?.name?.startsWith('accounts.membership.'))).toHaveLength(4);
    expect(DBOS.isInitialized()).toBe(false);
  } finally {
    step.mockRestore();
    workflow.mockRestore();
  }
  const descriptor = Object.getOwnPropertyDescriptor(DBOS, 'workflowID')!;
  let id = randomUUID();
  return {
    steps,
    async run(input: MembershipWorkInput) {
      id = randomUUID();
      Object.defineProperty(DBOS, 'workflowID', { configurable: true, get: () => id });
      try {
        return await run(input);
      } finally {
        Object.defineProperty(DBOS, 'workflowID', descriptor);
      }
    },
  };
}
async function rows(member: string) {
  return (
    await pool.query(`SELECT role FROM access.organization_member WHERE member_account_id=$1 AND upper_inf(valid)`, [
      member,
    ])
  ).rows;
}
async function inverses(member: string) {
  return (
    await pool.query('SELECT reservation_id::text FROM access.membership_inverse WHERE route=$1 AND account_id=$2', [
      routeOf(member),
      member,
    ])
  ).rows;
}
afterAll(async () => {
  server.stop(true);
  await client.close();
  await pool.end();
});

test('default registered accounts resolves persisted sealed input after resolver restart and publishes native join, role and leave', async () => {
  const f = await fixture();
  const input = await f.approve();
  expect(input.authorization).toContain('.');
  const id = `membership-native:${randomUUID()}`;
  await enqueueMembership(client, id, input);
  const stored = (await client.getWorkflow(id))!;
  expect(JSON.stringify(stored.input)).not.toContain(f.bearer);
  const restarted = await registered();
  const result = await restarted.run(stored.input![0] as MembershipWorkInput);
  if (result.status !== 'completed') throw new Error('Native admission failed');
  expect(await rows(f.member)).toEqual([{ role: 'member' }]);
  expect(await inverses(f.member)).toEqual([{ reservation_id: result.reservationId }]);
  const ports = createMembershipWorkPorts(context);
  const request = await ports.authorize(input.authorization, input);
  expect(request.actor).toMatchObject({
    accountId: f.actor,
    clientId: 'component',
    scopes: ['organization:membership'],
    requestedBy: null,
    authnEpoch: 1,
  });
  expect(workflowApprovalBinding(request)?.digest).toMatch(/^[0-9a-f]{64}$/);
  await (await registered()).run(await f.approve({ ...input, role: 'owner', reservationId: result.reservationId }));
  expect(await rows(f.member)).toEqual([{ role: 'owner' }]);
  await (await registered()).run(await f.approve({ ...input, role: null, reservationId: result.reservationId }));
  expect(await rows(f.member)).toEqual([]);
  expect(await inverses(f.member)).toEqual([]);
  expect(
    (
      await pool.query('SELECT role FROM access.organization_member WHERE member_account_id=$1 ORDER BY lower(valid)', [
        f.member,
      ])
    ).rows,
  ).toEqual([{ role: 'member' }, { role: 'owner' }]);
});

for (const negative of [
  'forged',
  'swapped',
  'role',
  'member',
  'target',
  'reservation',
  'revoked',
  'floor',
  'expired',
] as const) {
  test(`default registered reserve denies ${negative} approval before inverse or authority effects`, async () => {
    const f = await fixture(negative === 'expired' ? 3 : 300);
    let input = await f.approve();
    if (negative === 'forged') input.authorization += 'x';
    if (negative === 'swapped') input.authorization = (await (await fixture()).approve()).authorization;
    if (negative === 'role') input.role = 'owner';
    if (negative === 'member') input.memberAccountId = f.actor;
    if (negative === 'target') input.principal = { kind: 'organization', id: newId(0x4330) };
    if (negative === 'reservation') input.reservationId = newId(0x4320);
    if (negative === 'revoked')
      await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        routeOf(f.group),
        f.group,
      ]);
    if (negative === 'floor')
      await pool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
        routeOf(f.actor),
        f.actor,
      ]);
    if (negative === 'expired') {
      await Bun.sleep(Math.max(1, f.expires - Date.now() + 20));
      expect(
        (
          await pool.query('SELECT count(*)::int AS n FROM access.workflow_approval WHERE route=$1 AND actor_id=$2', [
            routeOf(f.actor),
            f.actor,
          ])
        ).rows[0].n,
      ).toBe(1);
    }
    const worker = await registered();
    await expect(worker.run(input)).rejects.toThrow();
    expect(await inverses(f.member)).toEqual([]);
    expect(await rows(f.member)).toEqual([]);
  });
}

test('publication re-resolves and a previously resolved context still checks native command-time authority', async () => {
  const f = await fixture();
  const input = await f.approve();
  const ports = createMembershipWorkPorts(context);
  const resolved = await ports.authorize(input.authorization, input);
  const held = (await ports.reserve({ accountId: f.member, principal: input.principal, key: randomUUID() })).value;
  await expect(
    ports.publish(resolved, input, { ...held, principal: { kind: 'organization', id: newId(0x4330) } }, randomUUID()),
  ).rejects.toThrow();
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [routeOf(f.group), f.group]);
  await expect((await registered()).steps.get('publish')!(input, held)).rejects.toThrow();
  await expect(ports.publish(resolved, input, held, randomUUID())).rejects.toThrow();
  expect(await rows(f.member)).toEqual([]);
  expect(await inverses(f.member)).toHaveLength(1);
  // Exact native compensation remains possible after authorization is revoked.
  // Release itself requires the committed terminal proof on the organization.
  const steps = (await registered()).steps;
  await expect(steps.get('release')!(held)).rejects.toThrow();
  await steps.get('terminalize')!(held);
  await steps.get('release')!(held);
  expect(await inverses(f.member)).toEqual([]);
});

test('configuration is validated before registration with the offending variable and no ambient fallback', async () => {
  const step = spyOn(DBOS, 'registerStep');
  try {
    const key = Buffer.alloc(32, 71).toString('base64url');
    const malformed = [
      '',
      '{}',
      '{"current":7,"keys":{"7":"' + key + '","7":"' + key + '"}}',
      '{"current":7,"keys":{"7":"' + key + '","\\u0037":"' + key + '"}}',
      ...[
        { current: 7, keys: { 8: key } },
        { current: 256, keys: { 256: key } },
        { current: 1, keys: { '01': key } },
        { current: 7, keys: { 7: key + '=' } },
        { current: 7, keys: { 7: Buffer.alloc(31).toString('base64url') } },
        { current: 0, keys: Object.fromEntries([0, 1, 2, 3, 4].map((id) => [id, key])) },
        { current: 7, keys: { 7: key }, unknown: true },
      ].map((value) => JSON.stringify(value)),
    ];
    for (const value of malformed)
      await expect(
        createAccountsWorkModule().register({ ...context, env: { ...env, KERNEL_WORKFLOW_REFERENCE_KEYS: value } }),
      ).rejects.toThrow('KERNEL_WORKFLOW_REFERENCE_KEYS');
    for (const variable of ['KERNEL_ROUTE_KEY', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL']) {
      for (const value of [undefined, 'invalid'])
        await expect(
          createAccountsWorkModule().register({ ...context, env: { ...env, [variable]: value } }),
        ).rejects.toThrow(variable);
    }
    expect(step).not.toHaveBeenCalled();
  } finally {
    step.mockRestore();
  }
});

test('invalid configuration registers no operations and a later valid registration succeeds', async () => {
  const operations = new Set<string>();
  const register = (fn: (...args: any[]) => any, name: string) => {
    if (operations.has(name)) throw new Error(`Operation ${name} is already registered`);
    operations.add(name);
    return fn;
  };
  const step = spyOn(DBOS, 'registerStep').mockImplementation(
    ((fn: (...args: any[]) => any, options: { name: string }) => register(fn, options.name)) as never,
  );
  const workflow = spyOn(DBOS, 'registerWorkflow').mockImplementation(
    ((fn: (...args: any[]) => any, options: { name: string }) => register(fn, options.name)) as never,
  );
  try {
    const invalid = [
      ['KERNEL_WORKFLOW_REFERENCE_KEYS', 'invalid'],
      ['KERNEL_ROUTE_KEY', 'invalid'],
      ['AUTH_ISSUER', 'invalid'],
      ['AUTH_AUDIENCE', 'invalid'],
      ['AUTH_JWKS_URL', 'invalid'],
    ] as const;
    for (const [variable, value] of invalid) {
      await expect(
        createAccountsWorkModule().register({ ...context, env: { ...env, [variable]: value } }),
      ).rejects.toThrow(variable);
      expect(operations.size).toBe(0);
    }

    await createAccountsWorkModule().register(context);
    expect(operations.size).toBeGreaterThan(0);
    await expect(createAccountsWorkModule().register(context)).rejects.toThrow('already registered');
  } finally {
    step.mockRestore();
    workflow.mockRestore();
  }
});

test('enqueue accepts bounded opaque native locators and rejects bearer, raw context and unknown fields', async () => {
  const f = await fixture();
  const input = await f.approve();
  const id = `membership-native:${randomUUID()}`;
  for (const value of [
    { ...input, authorization: f.bearer },
    { ...input, authorization: `Bearer ${f.bearer}` },
    { ...input, authorization: JSON.stringify({ actor: f.actor }) },
    { ...input, authorization: 'x'.repeat(4097) },
    { ...input, authorization: '' },
    { ...input, account: { accountId: f.actor } },
    { ...input, principal: { ...input.principal, actor: f.actor } },
  ])
    await expect(enqueueMembership(client, id, value as MembershipWorkInput)).rejects.toThrow(
      'Invalid membership work input',
    );
  expect(await client.getWorkflow(id)).toBeUndefined();
  await enqueueMembership(client, id, { ...input, authorization: 'a'.repeat(4052) + '.' + 'b'.repeat(43) });
  for (const value of [
    { kind: 'organization' as const, organizationId: f.group, authorization: input.authorization },
    { ...input, principal: { kind: 'realm' as const, id: f.group } },
  ])
    await expect(createMembershipWorkPorts(context).authorize(value.authorization, value)).rejects.toMatchObject({
      code: value.kind === 'membership' ? 'realm_membership_unavailable' : 'membership_authorization_unavailable',
    });
});

test('default resolver preserves delegated identity and both sides of native authorization', async () => {
  const f = await fixture();
  const principal = newId(0x4340),
    request = newId(0x4340);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES($1,$2,'actor','active',$2,true)`,
    [routeOf(principal), principal],
  );
  await pool.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,creator_principal_id,valid,transaction_id) VALUES($1,$2,$3,$4,$2,'(,)',$3)`,
    [routeOf(principal), principal, request, f.actor],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES($1,$2,$3,'organization:membership','(,)',$3)`,
    [routeOf(f.group), f.group, principal],
  );
  const now = Math.floor(Date.now() / 1000);
  const requestedBy = `urn:rezics:request:${principal}:${request}`;
  const bearer = await new SignJWT({
    sub: f.actor,
    client_id: 'delegated-component',
    scope: 'organization:membership account:read',
    requested_by: requestedBy,
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(env.AUTH_AUDIENCE)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(signing.privateKey);
  const approval = await approvals.approve(
    bearer,
    { operationKey: randomUUID(), operation: operation(f.input) },
    boundary(),
  );
  const input = { ...f.input, authorization: approval.reference };
  const resolved = await createMembershipWorkPorts(context).authorize(input.authorization, input);
  expect(resolved.actor).toMatchObject({
    accountId: f.actor,
    clientId: 'delegated-component',
    requestedBy,
    authnEpoch: 1,
  });
  expect([...resolved.actor.scopes].sort()).toEqual(['account:read', 'organization:membership']);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    routeOf(f.group),
    f.group,
    principal,
  ]);
  await expect((await registered()).run(input)).rejects.toThrow();
  expect(await inverses(f.member)).toEqual([]);
  expect(await rows(f.member)).toEqual([]);
});

test('default native last-owner failure retains authoritative history and inverse when compensation cannot terminalize', async () => {
  const f = await fixture();
  const reservationId = (await inverses(f.actor))[0]!.reservation_id as string;
  const input = await f.approve({ ...f.input, memberAccountId: f.actor, role: 'member', reservationId });
  await expect((await registered()).run(input)).rejects.toThrow();
  expect(await rows(f.actor)).toEqual([{ role: 'owner' }]);
  expect(await inverses(f.actor)).toEqual([{ reservation_id: reservationId }]);
  expect(
    (
      await pool.query(
        'SELECT terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3',
        [routeOf(f.group), f.group, f.actor],
      )
    ).rows,
  ).toEqual([{ terminal: false }]);
});

test('bounded deployment ring resolves outstanding approvals across rotation and rejects a removed key', async () => {
  const f = await fixture();
  const input = await f.approve();
  const encoded = {
    0: Buffer.alloc(32, 1).toString('base64url'),
    1: Buffer.alloc(32, 2).toString('base64url'),
    7: Buffer.alloc(32, 71).toString('base64url'),
    255: Buffer.alloc(32, 3).toString('base64url'),
  };
  const rotated = { ...env, KERNEL_WORKFLOW_REFERENCE_KEYS: JSON.stringify({ current: 255, keys: encoded }) };
  expect(readMembershipWorkConfig(rotated).referenceKeys.keys.size).toBe(4);
  expect(
    (await createMembershipWorkPorts({ ...context, env: rotated }).authorize(input.authorization, input)).actor
      .accountId,
  ).toBe(f.actor);
  const removed = {
    ...env,
    KERNEL_WORKFLOW_REFERENCE_KEYS: JSON.stringify({ current: 255, keys: { 255: encoded[255] } }),
  };
  await expect(
    createMembershipWorkPorts({ ...context, env: removed }).authorize(input.authorization, input),
  ).rejects.toThrow();
});

test('existing deployment seal ring is reused with bounded rotation and canonical keys', async () => {
  const f = await fixture();
  const input = await f.approve();
  const key = Buffer.alloc(32, 71).toString('base64url');
  const deployment = {
    ...env,
    KERNEL_SESSION_KEYS: `255:${Buffer.alloc(32, 9).toString('base64url')},7:${key}`,
    KERNEL_WORKFLOW_REFERENCE_KEYS: 'unused',
  };
  const ring = readMembershipWorkConfig(deployment).referenceKeys;
  expect(ring.current).toBe(255);
  expect([...ring.keys.keys()]).toEqual([255, 7]);
  expect(
    (await createMembershipWorkPorts({ ...context, env: deployment }).authorize(input.authorization, input)).actor
      .accountId,
  ).toBe(f.actor);
  for (const value of [
    '',
    `7:${key},7:${key}`,
    `256:${key}`,
    `07:${key}`,
    `7:${key}=`,
    `7:${Buffer.alloc(31).toString('base64url')}`,
    [0, 1, 2, 3, 4].map((id) => `${id}:${key}`).join(','),
  ])
    expect(() => readMembershipWorkConfig({ ...env, KERNEL_SESSION_KEYS: value })).toThrow('KERNEL_SESSION_KEYS');
});
