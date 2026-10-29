import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createAuthHost, type AccountOperationAccess } from '../src/index.ts';
import { accountOperationTransport } from '../src/account-operations-transport.ts';
import { createBarrierProofVerifier } from '../src/barrier-proofs.ts';
import { createNativeWorkflowProofPorts } from '../src/native-workflow-proofs.ts';
import { createProvisioningEvidenceVerifier } from '../src/provisioning-evidence.ts';
import { migrate, POSTGRES_IMAGE, run } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';

const issuer = 'https://account-operations.auth.test';
const audience = 'https://account-operations.api.test';
const password = 'account operation transport password';
const fixed = { error: 'account_operation_denied', effect_status: 'not_applied' };

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');

/** Each fixture owns exactly the container it starts. */
function ownDatabase() {
  const container = run('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=2g',
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    'POSTGRES_DB=rezics',
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
  ]);
  try {
    const port = run('docker', ['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)![1];
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    migrateKernel(url);
    migrate(url);
    return { url, close: () => run('docker', ['rm', '-f', container]) };
  } catch (error) {
    run('docker', ['rm', '-f', container]);
    throw error;
  }
}

type Native = {
  routeOf(id: string): number | null;
  PLATFORM_RESOURCE: { route: number; id: string };
};
let database: ReturnType<typeof ownDatabase>;
let kernelPool: Pool;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let native: Native;
let governor: Person;
let creator: Person;
let ordinary: Person;
let grantAny: Person;
let issueToken: (cookie: string) => Promise<string>;
let withheld: ReturnType<typeof accountOperationTransport>;
let automatedSubject: (human: Person, key: string) => Promise<{ accountId: string }>;
let grantGate: (granter: Person, recipient: Person, action: string) => Promise<void>;

type Person = { accountId: string; email: string; handle: string; cookie: string; bearer: string };

const call = (path: string, body: unknown, cookie = '', init: Partial<RequestInit> = {}) =>
  host.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    }),
  );
const approve = (person: Person, operationKey: string, operation: unknown) =>
  call('/account-operations/approve', { operationKey, operation }, person.cookie);
const execute = (person: Person, body: Record<string, unknown>) =>
  call('/account-operations/execute', body, person.cookie);
const orgHandle = () => `org_${randomUUID().replaceAll('-', '')}`;
async function counts() {
  return (
    await kernelPool.query(
      `SELECT (SELECT count(*) FROM access.workflow_approval)::int approvals,
        (SELECT count(*) FROM access.account)::int accounts,
        (SELECT count(*) FROM core.receipt)::int receipts`,
    )
  ).rows[0];
}
async function done(response: Response): Promise<unknown> {
  const body = await response.json();
  expect({ status: response.status, body }).toEqual({ status: 200, body: expect.anything() });
  return body;
}
async function ok(response: Response): Promise<{ reference: string; expiresAt: string; accountId: string }> {
  const body = await response.json();
  expect({ status: response.status, body }).toEqual({ status: 200, body: expect.anything() });
  return body as { reference: string; expiresAt: string; accountId: string };
}
async function refused(response: Response, status: number, body: unknown = fixed) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body as never);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}
async function responsibilityOf(subjectAccountId: string) {
  const row = (
    await kernelPool.query(
      `SELECT operator_account_id::text,operator_reservation_id::text,operator_relation_version::text
      FROM access.account WHERE route=$1 AND account_id=$2`,
      [native.routeOf(subjectAccountId), subjectAccountId],
    )
  ).rows[0];
  return {
    previous: {
      operatorAccountId: row.operator_account_id as string,
      subjectAccountId,
      reservationId: row.operator_reservation_id as string,
    },
    version: row.operator_relation_version as string,
  };
}
async function stateOf(accountId: string) {
  return (
    await kernelPool.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
      native.routeOf(accountId),
      accountId,
    ])
  ).rows[0]?.state as string | undefined;
}
async function person(name: string): Promise<Person> {
  const key = `${name}-${randomUUID()}`;
  const handle = key.replaceAll('-', '_');
  const email = `${key}@account-operations.test`;
  const { accountId } = await host.workflows.register({ key, handle, email, password });
  const signed = await call('/signin', { email, password, client_id: 'account-operations', scope: scopes });
  expect(signed.status).toBe(200);
  const cookie = cookies(signed);
  return { accountId, email, handle, cookie, bearer: await issueToken(cookie) };
}

const scopes = [
  'account:read',
  'account:update',
  'account:delete',
  'account:manage',
  'organization:create',
  'organization:membership',
  'access:grant',
  'gate:any',
];

beforeAll(async () => {
  database = ownDatabase();
  kernelPool = new Pool({ connectionString: database.url });
  authPool = new Pool({ connectionString: database.url });
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  let modules;
  try {
    await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    modules = {
      ...(await import('../../kernel/src/access/index.ts')),
      ...(await import('../../kernel/src/access/native-account-bindings.ts')),
      ...(await import('../../kernel/src/access/workflow-approvals.ts')),
      ...(await import('../../kernel/src/access/lifecycle.ts')),
      ...(await import('../../kernel/src/access/bootstrap-governance.ts')),
      ...(await import('../../kernel/src/access/gates/admission.ts')),
      ...(await import('../../kernel/src/route/route.ts')),
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  native = modules;
  const actions = new Map([...modules.LIFECYCLE_ACTIONS, ['access:grant', { anonymous: false }]]);
  actions.set('account:manage', { anonymous: false });
  let service: Awaited<ReturnType<typeof createAuthHost>>['service'];
  const access = modules.createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) };
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const bindings = modules.createNativeAccountBindings({
    pool: kernelPool,
    access,
    actions,
    routeKey: new Uint8Array(32).fill(95),
    referenceKeys,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
      barriers: createBarrierProofVerifier({ database: authPool }),
    },
  });
  const workflowApprovals = modules.createWorkflowApprovals({
    pool: kernelPool,
    access,
    actions,
    referenceKeys,
    creationBinding: proofs.creationBinding,
  });
  const context = () => ({ pool: kernelPool, deadline: Date.now() + 10000 });
  const accountOperations: AccountOperationAccess = {
    context,
    approve: (token, input, ctx) => workflowApprovals.approve(token, input as never, ctx as never),
    resolveForCaller: (token, reference, operation, ctx) =>
      workflowApprovals.resolveForCaller(token, reference, operation as never, ctx as never),
    async admitGroup(token, group, ctx) {
      const bounded = ctx as ReturnType<typeof context>;
      const actor = await access.authenticate(token, bounded);
      try {
        await modules.admitGroup({
          pool: kernelPool,
          access: () => access,
          actor,
          group,
          clientAction: 'organization:create',
          deadline: bounded.deadline,
          clock: () => new Date(),
        });
        return true;
      } catch (error) {
        if (error instanceof modules.PlatformClosedError) return false;
        throw error;
      }
    },
  };
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'ops' };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: randomBytes(48).toString('base64url'),
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts(bindings.trustedAccess),
    access: bindings.workflowPorts,
    accountOperations,
    stagingKey: randomBytes(32),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: `account-operations-${randomUUID()}`,
  });
  service = host.service;
  withheld = accountOperationTransport(service, host.workflows, (request) => service.handler(request), undefined);
  await service.internal.registerClient({ clientId: 'account-operations', firstParty: true, scopes });
  await host.start();
  issueToken = async (cookie) => {
    const response = await call('/token', {}, cookie);
    expect(response.status).toBe(200);
    return ((await response.json()) as { access_token: string }).access_token;
  };
  automatedSubject = async (human, key) => {
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operatorAccountId: human.accountId,
      handle: key.replaceAll('-', '_'),
      operationKey: key,
      authorization: 'approval-request',
    };
    const approved = await workflowApprovals.approve(human.bearer, { operationKey: key, operation }, context());
    return host.workflows.createAutomated({
      key,
      handle: operation.handle,
      operatorAccountId: human.accountId,
      authorization: approved.reference,
    });
  };
  governor = await person('governor');
  creator = await person('creator');
  ordinary = await person('ordinary');
  grantAny = await person('grant-any');
  const child = Bun.spawn(['bun', 'services/kernel/scripts/bootstrap-governance.ts', '--account', governor.accountId], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, DATABASE_URL: database.url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(child.stderr).text();
  expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
  grantGate = async (granter, recipient, action) => {
    const actor = await access.authenticate(granter.bearer, context());
    await bindings.grants.create(
      { ...context(), actor: actor as never },
      {
        resource: modules.PLATFORM_RESOURCE,
        subject: { kind: 'account', id: recipient.accountId },
        actions: [action],
        valid: '(,)',
        key: randomUUID(),
      },
    );
  };
  await grantGate(governor, creator, 'gate:organizations');
  await grantGate(governor, grantAny, 'gate:any');
}, 180000);

afterAll(async () => {
  await host?.stop();
  if (!host) await Promise.all([kernelPool?.end(), authPool?.end()]);
  else await kernelPool.end();
  database?.close();
}, 60000);

test('a signed-in person approves and executes organization creation rename and own account deletion over HTTP and receives the native result', async () => {
  const handle = orgHandle();
  const approval = await ok(await approve(creator, 'create-organization', { kind: 'organization', handle }));
  expect(Object.keys(approval).sort()).toEqual(['expiresAt', 'reference']);
  const created = await done(
    await execute(creator, {
      operationKey: 'create-organization',
      operation: { kind: 'organization', handle },
      reference: approval.reference,
    }),
  );
  expect(created).toEqual({ accountId: expect.any(String) });
  const organizationId = (created as { accountId: string }).accountId;
  expect(
    (
      await kernelPool.query('SELECT kind,state,handle FROM access.account WHERE route=$1 AND account_id=$2', [
        native.routeOf(organizationId),
        organizationId,
      ])
    ).rows,
  ).toEqual([{ kind: 'organization', state: 'active', handle }]);

  const renamed = `${creator.handle}_renamed`;
  const rename = { kind: 'rename', accountId: creator.accountId, handle: renamed, expectedHandle: creator.handle };
  const renameApproval = await ok(await approve(creator, 'rename-self', rename));
  expect(
    await done(
      await execute(creator, { operationKey: 'rename-self', operation: rename, reference: renameApproval.reference }),
    ),
  ).toEqual({ accountId: creator.accountId });
  expect(
    (
      await kernelPool.query('SELECT handle FROM access.account WHERE route=$1 AND account_id=$2', [
        native.routeOf(creator.accountId),
        creator.accountId,
      ])
    ).rows,
  ).toEqual([{ handle: renamed }]);

  // Own deletion returns the workflow outcome without re-authorizing against the standing it removes.
  // The person's authority ends for subsequent requests, even while the organization gate remains closed.
  const leaving = await person('leaving');
  const removal = { kind: 'delete', accountId: leaving.accountId };
  const removalApproval = await ok(await approve(leaving, 'delete-self', removal));
  const deleted = await execute(leaving, {
    operationKey: 'delete-self',
    operation: removal,
    reference: removalApproval.reference,
  });
  expect(await done(deleted)).toEqual({ accountId: leaving.accountId });
  expect(deleted.headers.get('cache-control')).toBe('no-store');
  expect(deleted.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await stateOf(leaving.accountId)).not.toBe('active');
  const later = await call('/account-operations/approve', { operationKey: 'after-delete', operation: removal }, '', {
    headers: {
      origin: issuer,
      'content-type': 'application/json',
      authorization: `Bearer ${leaving.bearer}`,
    },
  });
  expect({ status: later.status, body: await later.json(), challenge: later.headers.get('www-authenticate') }).toMatchObject({
    status: 401,
    body: { code: 'invalid_credentials' },
    challenge: 'Bearer error="invalid_token"',
  });
}, 120000);

test('a transfer is approved by the source manager accepted by the destination manager and executed', async () => {
  const source = await person('transfer-source');
  const destination = await person('transfer-destination');
  const subject = await automatedSubject(source, `transfer-subject-${randomUUID()}`);
  const { previous, version } = await responsibilityOf(subject.accountId);
  const transfer = {
    previous,
    expectedVersion: version,
    operatorAccountId: destination.accountId,
  };
  const key = `transfer-${randomUUID()}`;

  // Neither manager can execute an unaccepted or half-approved transfer.
  const accepted = await ok(
    await approve(destination, key, { kind: 'transfer-acceptance', ...transfer, sourceOperationKey: key }),
  );
  const sourceApproval = await ok(
    await approve(source, key, { kind: 'transfer', ...transfer, acceptance: accepted.reference }),
  );
  expect(
    (
      await execute(source, {
        operationKey: key,
        operation: { kind: 'transfer-acceptance', ...transfer, sourceOperationKey: key },
        reference: accepted.reference,
      })
    ).status,
  ).toBe(400);
  const result = await done(
    await execute(source, {
      operationKey: key,
      operation: { kind: 'transfer', ...transfer },
      reference: sourceApproval.reference,
      acceptance: accepted.reference,
    }),
  );
  expect(result).toEqual({ accountId: subject.accountId });
  expect(
    (
      await kernelPool.query('SELECT operator_account_id::text FROM access.account WHERE route=$1 AND account_id=$2', [
        native.routeOf(subject.accountId),
        subject.accountId,
      ])
    ).rows,
  ).toEqual([{ operator_account_id: destination.accountId }]);
}, 120000);

test('a request from another origin a non-JSON or oversized body an unknown field or an unknown operation kind is refused before any approval', async () => {
  const before = await counts();
  const body = { operationKey: 'refused', operation: { kind: 'organization', handle: orgHandle() } };
  const headers = (extra: Record<string, string>) => ({
    origin: issuer,
    'content-type': 'application/json',
    cookie: creator.cookie,
    ...extra,
  });
  const send = (path: string, init: RequestInit) => host.handler(new Request(`${issuer}${path}`, init));
  for (const path of ['/account-operations/approve', '/account-operations/execute']) {
    await refused(
      await send(path, {
        method: 'POST',
        headers: headers({ origin: 'https://evil.test' }),
        body: JSON.stringify(body),
      }),
      400,
    );
    await refused(
      await send(path, { method: 'POST', headers: { ...headers({}), origin: '' }, body: JSON.stringify(body) }),
      400,
    );
    await refused(
      await send(path, {
        method: 'POST',
        headers: headers({ 'content-type': 'text/plain' }),
        body: JSON.stringify(body),
      }),
      400,
    );
    await refused(await send(path, { method: 'POST', headers: headers({}), body: '{not json' }), 400);
    await refused(await send(path, { method: 'POST', headers: headers({}), body: '[]' }), 400);
    await refused(
      await send(path, {
        method: 'POST',
        headers: headers({}),
        body: JSON.stringify({ ...body, padding: 'x'.repeat(16384) }),
      }),
      413,
    );
    await refused(
      await send(path, {
        method: 'POST',
        headers: headers({}),
        body: JSON.stringify({ ...body, actor: creator.accountId }),
      }),
      400,
    );
    await refused(
      await send(path, {
        method: 'POST',
        headers: headers({}),
        body: JSON.stringify({ ...body, token: creator.bearer }),
      }),
      400,
    );
    await refused(await send(`${path}?x=1`, { method: 'POST', headers: headers({}), body: JSON.stringify(body) }), 400);
    await refused(await send(path, { method: 'GET', headers: headers({}) }), 400);
  }
  for (const operation of [
    { kind: 'organization', handle: orgHandle(), extra: true },
    { kind: 'organization', handle: orgHandle(), authorization: 'forged' },
    {
      kind: 'automated',
      registrationId: '',
      operatorAccountId: creator.accountId,
      handle: 'x',
      operationKey: 'refused',
    },
    { kind: 'revoke', accountId: creator.accountId },
    { kind: 'consent', accountId: creator.accountId, clientId: 'x', scopes: [] },
    { kind: 'opening', operatorAccountId: creator.accountId, subjectAccountId: ordinary.accountId },
    { kind: 'credential', subjectAccountId: creator.accountId },
    { kind: 'client-reduction', clientId: 'x', firstParty: false, scopes: [] },
    { kind: 'nothing' },
    { handle: 'x' },
    'organization',
    null,
  ])
    await refused(await approve(creator, 'refused', operation), 400);
  await refused(await execute(creator, { operationKey: 'refused', operation: body.operation }), 400);
  await refused(await execute(creator, { ...body, reference: 'r', acceptance: 'a' }), 400);
  expect(await counts()).toEqual(before);
}, 60000);

test('a missing or foreign session is refused', async () => {
  const before = await counts();
  const rename = {
    kind: 'rename',
    accountId: ordinary.accountId,
    handle: `${ordinary.handle}_x`,
    expectedHandle: ordinary.handle,
  };
  await refused(await call('/account-operations/approve', { operationKey: 'k', operation: rename }), 401);
  await refused(await approve({ ...creator, cookie: 'better-auth.session_token=forged' }, 'k', rename), 401);
  // A foreign session cannot approve for someone else's account.
  await refused(await approve(creator, 'foreign-rename', rename), 403);
  // Nor execute someone else's approval.
  const approval = await ok(await approve(ordinary, 'owned-rename', rename));
  const stolen = { operationKey: 'owned-rename', operation: rename, reference: approval.reference };
  await refused(await execute(creator, stolen), 403);
  await refused(await call('/account-operations/execute', stolen), 401);
  expect((await counts()).accounts).toBe(before.accounts);
  expect(
    (
      await kernelPool.query('SELECT handle FROM access.account WHERE route=$1 AND account_id=$2', [
        native.routeOf(ordinary.accountId),
        ordinary.accountId,
      ])
    ).rows,
  ).toEqual([{ handle: ordinary.handle }]);
}, 60000);

test('a denied operation answers one fixed error shape that discloses nothing', async () => {
  const absent = await person('absent');
  const shapes = new Set<string>();
  const attempts = [
    approve(creator, 'denied-1', { kind: 'delete', accountId: ordinary.accountId }),
    approve(creator, 'denied-2', { kind: 'delete', accountId: newAbsentAccount() }),
    approve(creator, 'denied-3', {
      kind: 'membership',
      organizationId: ordinary.accountId,
      memberAccountId: creator.accountId,
      role: 'owner',
    }),
    approve(creator, 'denied-4', { kind: 'fence-operator', accountId: absent.accountId }),
    approve(creator, 'denied-5', {
      kind: 'rename',
      accountId: ordinary.accountId,
      handle: 'taken',
      expectedHandle: null,
    }),
  ];
  for (const response of await Promise.all(attempts)) {
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    shapes.add(await response.text());
  }
  expect([...shapes]).toEqual([JSON.stringify(fixed)]);
  function newAbsentAccount() {
    return ordinary.accountId.slice(0, -4) + 'ffff';
  }
}, 60000);

test('a replay with the same operation key returns the same result without repeating effects', async () => {
  const handle = orgHandle();
  const operation = { kind: 'organization', handle };
  const approval = await ok(await approve(creator, 'replayed', operation));
  const body = { operationKey: 'replayed', operation, reference: approval.reference };
  const first = await done(await execute(creator, body));
  const mid = await counts();
  expect(await done(await execute(creator, body))).toEqual(first);
  expect(await counts()).toEqual(mid);
  // A fresh approval of the same immutable operation resolves to the same account.
  const refreshed = await ok(await approve(creator, 'replayed', operation));
  const approved = await counts();
  expect(await done(await execute(creator, { ...body, reference: refreshed.reference }))).toEqual(first);
  const after = await counts();
  expect(after).toEqual(approved);
  expect((await kernelPool.query('SELECT 1 FROM access.account WHERE handle=$1', [handle])).rowCount).toBe(1);
}, 120000);

test('an approval from a session authenticated more than ten minutes ago answers 401 step_up_required and approves nothing', async () => {
  const stale = await person('stale');
  const operation = {
    kind: 'rename',
    accountId: stale.accountId,
    handle: `${stale.handle}_new`,
    expectedHandle: stale.handle,
  };
  const fresh = await ok(await approve(stale, 'before-stale', operation));
  await authPool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1', [
    stale.accountId,
    Math.floor(Date.now() / 1000) - 601,
  ]);
  const before = await counts();
  const response = await approve(stale, 'stale', operation);
  await refused(response, 401, { error: 'step_up_required', effect_status: 'not_applied' });
  expect(await counts()).toEqual(before);
  // Execute needs no fresh session beyond the approval it carries.
  expect(
    await done(await execute(stale, { operationKey: 'before-stale', operation, reference: fresh.reference })),
  ).toEqual({
    accountId: stale.accountId,
  });
  await authPool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1', [
    stale.accountId,
    Math.floor(Date.now() / 1000) - 599,
  ]);
  await ok(
    await approve(stale, 'fresh-again', {
      ...operation,
      expectedHandle: `${stale.handle}_new`,
      handle: `${stale.handle}_newer`,
    }),
  );
}, 120000);

test('organization creation while its gate is closed answers 403 platform_closed to an ungranted person and proceeds for a person granted gate organizations or gate any', async () => {
  const closed = { error: 'platform_closed', effect_status: 'not_applied' };
  const before = await counts();
  await refused(await approve(ordinary, 'gated', { kind: 'organization', handle: orgHandle() }), 403, closed);
  expect(await counts()).toEqual(before);
  for (const granted of [creator, grantAny, governor]) {
    const body = await ok(
      await approve(granted, `gated-${granted.accountId}`, { kind: 'organization', handle: orgHandle() }),
    );
    expect(body.reference).toBeString();
  }
  // Only organization creation is gated.
  const rename = {
    kind: 'rename',
    accountId: ordinary.accountId,
    handle: `${ordinary.handle}_r`,
    expectedHandle: ordinary.handle,
  };
  await ok(await approve(ordinary, 'ungated-rename', rename));
  await ok(await approve(ordinary, 'ungated-delete', { kind: 'delete', accountId: ordinary.accountId }));
  // An open group admits everyone.
  await kernelPool.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id) VALUES ('organizations', tstzrange(statement_timestamp()-interval '1 second', NULL, '[)'), $1)`,
    [randomUUID()],
  );
  try {
    await ok(await approve(ordinary, 'opened', { kind: 'organization', handle: orgHandle() }));
  } finally {
    await kernelPool.query(`DELETE FROM access.exposure_opening WHERE "group"='organizations'`);
  }
}, 120000);

test('without the account operation ports both routes answer 503 and approve nothing', async () => {
  const before = await counts();
  for (const path of ['/account-operations/approve', '/account-operations/execute'])
    await refused(
      await withheld(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie: creator.cookie },
          body: JSON.stringify({
            operationKey: 'k',
            operation: { kind: 'organization', handle: orgHandle() },
            reference: 'r',
          }),
        }),
      ),
      503,
    );
  expect(await counts()).toEqual(before);
});

test('deletion is never gated', async () => {
  const leaving = await person('ungated-leaving');
  const removal = { kind: 'delete', accountId: leaving.accountId };
  await refused(await approve(leaving, 'gated-organization', { kind: 'organization', handle: orgHandle() }), 403, {
    error: 'platform_closed',
    effect_status: 'not_applied',
  });
  const approval = await ok(await approve(leaving, 'ungated-delete-self', removal));
  expect(approval.reference).toBeString();
  await execute(leaving, { operationKey: 'ungated-delete-self', operation: removal, reference: approval.reference });
  expect(await stateOf(leaving.accountId)).not.toBe('active');
}, 120000);
