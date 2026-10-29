import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Elysia } from 'elysia';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService, type AuthService } from '@rezics/auth';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { accessActionCatalogue, createAccess, INTERNAL_ACTIONS } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import {
  completeAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
} from '../../src/access/agent-verification.ts';
import { createKernel, createKernelAccessResolver } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const key = () => crypto.randomUUID();
const password = 'default kernel internal action password';
const audience = 'https://default-kernel.api.test';
const routeKey = new Uint8Array(32).fill(86);
const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(87)]]) };
const clock = () => new Date();
const savedEnv = ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'KERNEL_WRITE_RATE_SECRET'].map(
  (name) => [name, process.env[name]] as const,
);
let db: GrowthDatabase;
let auth: AuthService;
let server: ReturnType<typeof Bun.serve>;
let issuer: string;
let kernel: ReturnType<typeof createKernel>;
let access: ReturnType<typeof createAccess>;
let bindings: ReturnType<typeof createNativeAccountBindings>;
let scopes: string[];
let staff: Awaited<ReturnType<typeof person>>;
let manager: Awaited<ReturnType<typeof person>>;
let outsider: Awaited<ReturnType<typeof person>>;
let organization: string;

async function authPost(path: string, body: unknown, headers = new Headers()) {
  return auth.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
      body: JSON.stringify(body),
    }),
  );
}
async function login(accountId: string, requestedScopes = scopes, candidate = password) {
  const signed = await authPost('/signin', {
    email: `${accountId}@internal.test`,
    password: candidate,
    client_id: 'internal-test',
    scope: requestedScopes,
  });
  expect(signed.status).toBe(200);
  const headers = new Headers({
    cookie: signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  });
  const token = await authPost('/token', {}, headers);
  expect(token.status).toBe(200);
  return { headers, bearer: ((await token.json()) as { access_token: string }).access_token };
}
async function person() {
  const accountId = newId(0x5680);
  const handle = `internal_${key().replaceAll('-', '')}`;
  const held = await bindings.internalLifecycle.reserveHandle({ accountId, handle, key: key() });
  const input = { accountId, handle, reservationId: held.value.reservationId, key: key() };
  const outcome = await bindings.internalLifecycle.createPending(input);
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys });
  const authorization = (await registration.createProvisioningReference({ input, outcome }))!;
  await auth.internal.provisionPassword({ authorization, email: `${accountId}@internal.test`, password });
  // Fixture activation; requests and credential effects use the production native ports.
  await db.admin.query("UPDATE access.account SET state='active' WHERE account_id=$1", [accountId]);
  await bindings.operators.provisionManagementDefaults({ operatorAccountId: accountId, key: key() });
  return { accountId, ...(await login(accountId)) };
}
async function post(path: string, bearer: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        [IDEMPOTENCY_HEADER]: JSON.stringify(key()),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  migrateAuth(db.url);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => auth.handler(request) });
  issuer = `http://127.0.0.1:${server.port}`;
  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_AUDIENCE = audience;
  process.env.AUTH_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.KERNEL_WRITE_RATE_SECRET = 'default-kernel-native-rate-secret-at-least-32-bytes';
  // No Access factory, action or rate override: exercise the default kernel.
  kernel = createKernel({ pool: db.pool, routeKey, tokens: referenceKeys });
  const mounted = actionCatalogue(kernel);
  expect(mounted.has('account:manage')).toBe(false);
  // Auth's native bindings use the same default resolver and complete mounted catalogue.
  access = createKernelAccessResolver({ pool: db.pool, tokens: referenceKeys, clock }).resolveAccess({
    actions: mounted,
  });
  const actions = accessActionCatalogue(mounted);
  // Generic clients cannot register the website's exclusive completion scope.
  scopes = [...actions.keys()].filter((scope) => scope !== 'media:complete');
  bindings = createNativeAccountBindings({
    pool: db.pool,
    access,
    actions,
    routeKey,
    referenceKeys,
    auth: () => auth,
    proofs: {
      provisioning: { resolve: async () => null } as never,
      barriers: { verify: async () => null } as never,
      workflow: {
        recordPending: async () => {},
        pendingReference: async () => null,
        provisioningEvidence: async () => null,
      },
    },
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  auth = await createAuthService({
    database: db.openPool(),
    issuer,
    audience,
    secret: 'default-kernel-internal-secret-at-least-32-bytes',
    signing: { activeKid: 'internal', privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid: 'internal' }] },
    trustedAccess: bindings.trustedAccess,
  });
  await auth.internal.registerClient({ clientId: 'internal-test', firstParty: true, scopes });
  staff = await person();
  manager = await person();
  outsider = await person();
  await bootstrapGovernance(db.pool, staff.accountId);
  expect((await post('/v1/platform/exposure/agent_verification:open', staff.bearer)).status).toBe(200);
  await bootstrapRelease(db.pool, bundledRelease);
  organization = newId(0x5681);
  const held = await bindings.internalLifecycle.reserveCoordination({
    accountId: manager.accountId,
    relatedAccountId: organization,
    purpose: 'membership',
    key: key(),
  });
  await bindings.internalLifecycle.createOrganization({
    organizationId: organization,
    ownerAccountId: manager.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  await ensureAccountAgent(db.pool, {
    account: organization,
    kind: 'organization',
    name: 'Managed organization',
    language: 'en',
  });
}, 60_000);

afterAll(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await server?.stop(true);
  await db?.close();
});

async function catalogueOrganization() {
  const id = newId(0x5682);
  const resource = { route: routeOf(id)!, id };
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,'subject:create','(,)',$3)`,
    [resource.route, id, staff.accountId],
  );
  const context = { pool: db.pool, deadline: Date.now() + 10000 };
  const actor = await access.authenticate(staff.bearer, context);
  await createSubject(db.pool, {
    actor,
    target: resource,
    idempotencyKey: key(),
    digest: createHash('sha256').update(key()).digest(),
    item: { type: 'schema:Organization', labels: { en: 'Catalogue organization' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: await accessCommandAuthorization(
      access,
      actor,
      'subject:create',
      resource,
      context,
      () => new Error('Fixture subject denied'),
    ),
  });
  return id;
}

test('default kernel admits organization verification and release only with both a real management grant and session scope', async () => {
  const subject = await catalogueOrganization();
  const path = `/v1/accounts/${organization}`;
  const body = { subject, statement: 'I represent this organization', links: [] };
  const narrowed = await login(
    manager.accountId,
    scopes.filter((scope) => scope !== 'account:manage'),
  );
  for (const bearer of [outsider.bearer, narrowed.bearer]) {
    expect(await post(`${path}:requestVerification`, bearer, body)).toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    });
  }
  const requested = await post(`${path}:requestVerification`, manager.bearer, body);
  expect(requested).toMatchObject({
    status: 201,
    body: { verificationRequest: { accountId: organization, requestedBy: manager.accountId } },
  });
  const requestId = requested.body.verificationRequest.id;
  expect((await post(`/v1/verification-requests/${requestId}:approve`, staff.bearer, {})).status).toBe(200);
  const decision = (await readAgentVerificationWorkflowRequest(db.pool, requestId))!;
  const workflow = { ...decision, receiptId: decision.decisionReceiptId! };
  await recordPendingAgentVerification(db.pool, workflow, clock);
  await mergeVerifiedAgent(db.pool, workflow);
  await writeAgentVerificationPage(db.pool, workflow);
  await completeAgentVerification(db.pool, workflow, clock);
  await finishAgentVerification(db.pool, workflow, clock);
  for (const bearer of [outsider.bearer, narrowed.bearer]) {
    expect(await post(`${path}:releaseVerification`, bearer)).toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    });
  }
  expect(await post(`${path}:releaseVerification`, manager.bearer)).toMatchObject({
    status: 200,
    body: { reversal: { kind: 'released', accountId: organization, requestedBy: manager.accountId } },
  });
});

test('default kernel Access credential floor bridge authorizes account manage without an injected catalogue action', async () => {
  const human = await person();
  const credential = { kind: 'password' as const, password: 'replacement default kernel password' };
  const stage = await auth.internal.stageCredentialEffect({
    key: key(),
    subjectAccountId: human.accountId,
    headers: human.headers,
    credential,
  });
  const input = { ...stage, subjectAccountId: human.accountId, headers: human.headers };
  const approved = await auth.internal.approveCredentialEffect(input);
  expect(await auth.internal.applyCredentialEffect({ ...input, authorization: approved.reference })).toMatchObject({
    replayed: false,
  });
  expect(
    (await db.admin.query('SELECT minimum_authn_epoch FROM access.account WHERE account_id=$1', [human.accountId]))
      .rows[0].minimum_authn_epoch,
  ).toBe('2');
  await login(human.accountId, scopes, credential.password);
});

function mountedAction(
  action: string,
  metadata: { anonymous: boolean; replay?: 'self-account-read'; 'x-resource-types'?: readonly string[] },
) {
  const detail = {
    operationId: 'internal.read',
    'x-action': action,
    security: metadata.anonymous ? [{}] : [{ bearerAuth: [] }],
    ...(metadata.replay ? { 'x-replay-authorization': metadata.replay } : {}),
    ...(metadata['x-resource-types'] ? { 'x-resource-types': metadata['x-resource-types'] } : {}),
  };
  return new Elysia().get('/internal', { detail }, () => 'ok');
}

test('internal actions are additive, keep identical route metadata and reject conflicts at composition', () => {
  const names = [
    'gate:any',
    'account:manage',
    'account:delete',
    'account:assign_reserved_handle',
    'organization:create',
    'organization:membership',
    'client:manage',
    'access:delegate',
    'account:renew_cleanup',
  ];
  expect([...INTERNAL_ACTIONS.keys()]).toEqual(names);
  for (const [action, metadata] of INTERNAL_ACTIONS) {
    const mounted = actionCatalogue(mountedAction(action, metadata));
    const before = structuredClone(mounted.get(action));
    const actions = accessActionCatalogue(mounted);
    expect(actions.get(action)).toEqual(before);
    expect(mounted.size).toBe(1);
    expect(actions.size).toBe(names.length);
    expect(() => createAccess({ actions: mounted })).not.toThrow();
    const { replay, ...withoutReplay } = metadata;
    for (const conflict of [
      { ...metadata, anonymous: true },
      replay === undefined ? { ...metadata, replay: 'self-account-read' as const } : withoutReplay,
      { ...metadata, 'x-resource-types': ['account'] },
    ]) {
      const declared = actionCatalogue(mountedAction(action, conflict));
      expect(() => createAccess({ actions: declared })).toThrow(action);
      expect(() =>
        createKernelAccessResolver({ pool: db.pool, tokens: referenceKeys, clock }).resolveAccess({
          actions: declared,
        }),
      ).toThrow(action);
    }
  }
});
