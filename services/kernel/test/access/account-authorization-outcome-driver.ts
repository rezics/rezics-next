import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  WEBSITE_CLIENT_ID,
  type AuthService,
  type PublicJwks,
} from '@rezics/auth';
import { DBOS, type FunctionName, type StepConfig } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWorkflowApprovals, WorkflowApprovalDeniedError } from '../../src/access/workflow-approvals.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { APPROVAL_REFERENCE_PURPOSE } from '../../src/access/approved-identity.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createLifecycleInternals, LIFECYCLE_ACTIONS, LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands, DelegationDeniedError } from '../../src/access/delegation-commands.ts';
import { OperatorDeniedError } from '../../src/access/operator.ts';
import { ContinuationDeniedError } from '../../src/access/committed-continuations.ts';
import {
  createAuthBindings,
  AuthBindingDeniedError,
  AuthBindingUnavailableError,
} from '../../src/access/auth-bindings.ts';
import { accessCheck } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { seal, unseal } from '../../src/tokens/seal.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { registerTestClient, testKernel, testRouteKey, type TestKernel } from '../support/test-kernel.ts';
import type {
  AccountAuthorizationDriver,
  Approval,
  AuthPurpose,
  BarrierFault,
  Capability,
  Denied,
  Fixture,
  Operation,
  Revocation,
} from '../../../../specs/account-authorization-driver.ts';

const password = 'account-authorization-test-password';
const scopes = [
  'account:manage',
  'account:read',
  'account:update',
  'account:delete',
  'account:suspend',
  'organization:membership',
  'access:grant',
  'access:delegate',
  'client:manage',
].sort();
const denied: Denied = { outcome: 'denied' };
// While a production capability is left out of the composition, its absence is the product's refusal.
let capabilityOmitted = false;
const SESSION_OPENING = 'access.operator-session.v1';
const REGISTRATION_PROOF = 'access.registration-proof.v1';

// One wrapper for the process: every protected Auth workflow step announces itself to the live driver before it
// authorizes, so a checkpoint can pause exactly there and the production step list can be enumerated.
type StepListener = (name: string) => Promise<void>;
const stepListeners = new Set<StepListener>();
const registerStep = DBOS.registerStep.bind(DBOS);
DBOS.registerStep = (<This, Args extends unknown[], Return>(
  func: (this: This, ...args: Args) => Promise<Return>,
  config?: StepConfig & FunctionName,
) =>
  registerStep<This, Args, Return>(async function (this: This, ...args: Args) {
    const name = config?.name ?? '';
    for (const listener of [...stepListeners])
      await listener(name.startsWith('accounts.') ? name.slice('accounts.'.length) : name);
    return func.apply(this, args);
  }, config)) as typeof DBOS.registerStep;

const permitted = (receiptId?: string) => ({
  outcome: 'permitted' as const,
  ...(receiptId === undefined ? {} : { receiptId }),
});

const required = <T>(value: T | null | undefined, message: string): T => {
  if (value == null) throw new Error(message);
  return value;
};
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; '),
  });
const route = (id: string) => required(routeOf(id), `Not a route-bearing id: ${id}`);
const unavailable = (): never => {
  throw new Error('Auth delivered no recovery token');
};
const unique = (prefix: string) => `${prefix}-${randomUUID()}`;
const handleOf = (prefix: string) =>
  `${prefix.replaceAll(/[^a-z0-9]/gi, '_').toLowerCase()}_${randomUUID().slice(0, 8)}`;

/** Only a native refusal is an outcome; transport and programming failures keep their identity. */
function refusal(error: unknown): boolean {
  return (
    error instanceof WorkflowApprovalDeniedError ||
    error instanceof LifecycleDeniedError ||
    error instanceof GrantDeniedError ||
    error instanceof DelegationDeniedError ||
    error instanceof OperatorDeniedError ||
    error instanceof ContinuationDeniedError ||
    error instanceof AuthBindingDeniedError ||
    (error instanceof Error && error.message === 'Account workflow denied') ||
    (capabilityOmitted && error instanceof AuthBindingUnavailableError) ||
    (typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      [400, 401, 403, 409].includes(error.status as number))
  );
}
async function refused<T>(work: () => Promise<T>): Promise<T | Denied> {
  try {
    return await work();
  } catch (error) {
    if (refusal(error)) return denied;
    throw error;
  }
}
/** An HTTP answer from Auth: a 2xx grants; a 4xx, or any status carrying Auth's own denial code, is a refusal. */
async function answer<T>(response: Response, label: string): Promise<{ status: number; body: T } | Denied> {
  const text = await response.clone().text();
  const code = (() => {
    try {
      return (JSON.parse(text) as { error?: unknown }).error;
    } catch {
      return undefined;
    }
  })();
  const refusedByAuth = ['authentication_denied', 'credential_effect_denied', 'account_operation_denied'].includes(
    code as string,
  );
  if (response.status >= 500 && !refusedByAuth && !(capabilityOmitted && response.status === 503))
    throw new Error(`${label}: HTTP ${response.status}: ${text}`);
  if (!response.ok) return denied;
  return { status: response.status, body: (JSON.parse(text || '{}') ?? {}) as T };
}

type Person = { accountId: string; email: string; handle: string; session: Headers };
type Automated = { accountId: string; email: string; password: string };
type Record_ = {
  fixture: Fixture;
  actor: Person;
  principal: Person;
  target: Person;
  sessions: { actor: Headers; actorOther: Headers; principal: Headers };
  appClient: string;
  otherClient: string;
  requestId: string;
  bearers: string[];
  approvals: string[];
  automated: Automated[];
  pendings: string[];
  baseline: Set<string>;
  password: string;
  organization?: string;
};
type CredentialOperation = { key: string; subjectId: string; effectRef: string; purpose: string; digest: string };
type BarrierWrap = {
  fault: BarrierFault | undefined;
  kind: 'consent' | 'recovery';
  beforeAuth:
    | ((value: { accountId: string; previousFloor: string; newFloor: string; receiptId: string }) => Promise<void>)
    | undefined;
  observed: { receiptId: string; floor: string } | undefined;
  target: string;
  error?: unknown;
};
type Fence = { accountId: string; receiptId: string; minimumAuthnEpoch: number };

export async function createAccountAuthorizationDriver(): Promise<AccountAuthorizationDriver> {
  const source = new URL(required(process.env.DATABASE_URL, 'DATABASE_URL must name a migrated kernel database'));
  const template = decodeURIComponent(source.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(template)) throw new Error('Unsafe template database name');
  const suffix = randomUUID().replaceAll('-', '');
  const kernelName = `account_authz_kernel_${suffix}`;
  const authName = `account_authz_auth_${suffix}`;
  const connection = (name: string) => {
    const url = new URL(source.href);
    url.pathname = `/${name}`;
    return url.href;
  };
  const issuer = `https://account-authz-${suffix}.auth.test`;
  const audience = 'https://account-authz.api.test';
  const loginClient = `login-${suffix}`;
  const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const stagingKey = randomBytes(32);
  const hostSecret = randomBytes(48).toString('base64url');
  const routeKey = testRouteKey();
  const actions = new Map([...LIFECYCLE_ACTIONS, ...scopes.map((scope) => [scope, { anonymous: false }] as const)]);
  const signingPair = await generateKeyPair('ES256', { extractable: true });
  const signingKey = { ...(await exportJWK(signingPair.privateKey)), kid: `account-authz-${suffix}` };
  const websitePair = await generateKeyPair('ES256', { extractable: true });
  const redirectUri = `${issuer}/website/callback`;

  // The kernel clock is the real clock plus one controllable offset. Only an explicit advance moves it; nothing waits,
  // no timestamp is rewritten, and the process clock that Auth and the JWT libraries read is never touched.
  let advancedMs = 0;
  const clock = () => new Date(Date.now() + advancedMs);

  const created: string[] = [];
  const admin = new Pool({ connectionString: connection('postgres') });
  let kernelPool: ReturnType<typeof createPool>;
  let facts: Pool;
  let authPool: Pool;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let service!: AuthService;
  let bindings: ReturnType<typeof createNativeAccountBindings>;
  let approvals: ReturnType<typeof createWorkflowApprovals>;
  let access: TestKernel['testAccess'];
  let reader: TestKernel['testAccess'];
  let governor: Person | undefined;
  let closed = false;
  let restorePrepare: (() => void) | undefined;
  let barrierWrap: BarrierWrap | undefined;
  let omitted: Capability | undefined;
  let recoveryToken = '';
  const records = new Map<string, Record_>();
  const byOperation = new Map<string, Record_>();
  const callers = new Map<string, { person: Person; requestedBy: string | null }>();
  const checkpointBaseline = new Map<string, number>();
  const stepsByKind = new Map<string, string[]>();
  const credentialOperations = new Map<string, CredentialOperation>();
  const openings = new Map<string, { purpose: AuthPurpose; subject: Automated }>();
  const held: { release(): void; done: Promise<unknown> }[] = [];
  const expiredPendings = new Set<string>();
  const partitions = new Set<number>();

  const delegations = () => createDelegationCommands({ pool: kernelPool, access, action: 'account:manage' });
  const context = () => ({ pool: kernelPool, deadline: Date.now() + 30_000 });
  const hostRequest = (path: string, body: unknown, session?: Headers) =>
    required(host, 'Auth host is stopped').handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: session?.get('cookie') ?? '' },
        body: JSON.stringify(body),
      }),
    );
  async function successful<T>(response: Response, label: string): Promise<T> {
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }
  async function login(email: string, clientId: string, requested = scopes, secret = password): Promise<Headers> {
    const response = await hostRequest('/signin', { email, password: secret, client_id: clientId, scope: requested });
    await successful(response.clone(), 'Auth sign-in');
    return cookies(response);
  }
  async function bearer(session: Headers, requestedBy: string | null = null): Promise<string> {
    const response = await hostRequest('/token', requestedBy === null ? {} : { requested_by: requestedBy }, session);
    return (await successful<{ access_token: string }>(response, 'Auth token')).access_token;
  }
  const actorFor = (token: string, via = access) => via.authenticate(token, context());

  /** The kernel-facing trusted ports. A fault or omission is applied only at this untrusted boundary. */
  function trustedPorts() {
    const base = bindings.trustedAccess;
    const absent = createAuthBindings({ pool: kernelPool });
    const wrapBarrier =
      (kind: 'consent' | 'recovery', port: 'invalidateAccount' | 'authorizeRecovery') =>
      async (input: { accountId: string; previousEpoch?: number; proofEpoch?: number; proofReference?: string }) => {
        const wrap = barrierWrap?.kind === kind ? barrierWrap : undefined;
        const send = base[port] as (value: unknown) => Promise<Fence>;
        if (!wrap) return send(input);
        const previous = input.previousEpoch ?? input.proofEpoch ?? 0;
        const epochField = kind === 'consent' ? 'previousEpoch' : 'proofEpoch';
        let sent: Record<string, unknown> = { ...input };
        if (wrap.fault === 'account') sent = { ...sent, accountId: wrap.target };
        if (wrap.fault === 'previous-floor') sent = { ...sent, [epochField]: previous + 1 };
        if (wrap.fault === 'untrusted-proof') sent = { ...sent, proofReference: randomBytes(32).toString('hex') };
        let receipt: Fence;
        if (wrap.fault === 'stale-proof') {
          // The proof outlives its own validity: the clock moves past its expiry before Access sees it.
          const before = advancedMs;
          advancedMs += 400 * 24 * 3600_000;
          try {
            receipt = await send(sent);
          } finally {
            advancedMs = before;
          }
        } else receipt = await send(sent);
        wrap.observed = { receiptId: receipt.receiptId, floor: String(receipt.minimumAuthnEpoch) };
        const observed = wrap.observed;
        try {
          await wrap.beforeAuth?.({
            accountId: receipt.accountId,
            previousFloor: String(previous),
            newFloor: observed.floor,
            receiptId: observed.receiptId,
          });
        } catch (error) {
          // The assertion belongs to the caller; Auth only sees an interrupted barrier.
          wrap.error = error;
          throw error;
        }
        if (wrap.fault === 'new-floor') receipt = { ...receipt, minimumAuthnEpoch: receipt.minimumAuthnEpoch + 1 };
        if (wrap.fault === 'receipt') receipt = { ...receipt, receiptId: randomUUID() };
        return receipt;
      };
    const ports = {
      ...base,
      invalidateAccount: wrapBarrier('consent', 'invalidateAccount'),
      authorizeRecovery: wrapBarrier('recovery', 'authorizeRecovery'),
    } as typeof base;
    const replace = ports as unknown as Record<string, unknown>;
    if (omitted === 'verifyProvisioningReceipt') replace.authorizeProvisioning = absent.authorizeProvisioning;
    if (omitted === 'consumeAuthAuthorization') replace.consumeAuthorization = absent.consumeAuthorization;
    if (omitted === 'invalidateAccount') replace.invalidateAccount = absent.invalidateAccount;
    if (omitted === 'authorizeRecovery') replace.authorizeRecovery = absent.authorizeRecovery;
    return ports;
  }
  function workflowPorts() {
    const ports = bindings.workflowPorts;
    if (omitted !== 'authorizeOperation') return ports;
    return new Proxy(ports, {
      get: (target, property) => (property === 'authorizeOperation' ? undefined : Reflect.get(target, property)),
    });
  }

  async function build() {
    authPool = new Pool({ connectionString: connection(authName) });
    const authentication = {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    };
    const compose = () =>
      testKernel({
        pool: kernelPool,
        actions,
        tokens: referenceKeys,
        clock,
        auth: authentication,
        writeRate: createWriteRateLimiter({ secret: hostSecret }),
      });
    access = compose().testAccess;
    reader = compose().testAccess;
    const proofs = createNativeWorkflowProofPorts({ database: authPool });
    bindings = createNativeAccountBindings({
      pool: kernelPool,
      access,
      actions,
      routeKey,
      clock,
      referenceKeys,
      auth: () => service,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
        barriers: createBarrierProofVerifier({ database: authPool }),
      },
    });
    approvals = createWorkflowApprovals({
      pool: kernelPool,
      access,
      actions,
      referenceKeys,
      creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
    });
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: hostSecret,
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      siteActions: new Map([...actions, ['media:complete', { anonymous: false }]]),
      trustedAccess: trustedPorts(),
      access: workflowPorts(),
      stagingKey,
      maintenanceSchedule: '0 0 1 1 *',
      executorId: `account-authz-${suffix}`,
      recoveryDelivery: {
        async deliver(value) {
          recoveryToken = value.token;
        },
      },
    });
    service = host.service;
    await host.start();
  }
  async function stop() {
    restorePrepare?.();
    restorePrepare = undefined;
    await host?.stop();
    host = undefined;
    await authPool?.end().catch(() => {});
  }
  /** Rebuild the Auth host with one production capability left out of its composition. */
  async function without<T>(capability: Capability, work: () => Promise<T>): Promise<T> {
    await stop();
    omitted = capability;
    capabilityOmitted = true;
    await build();
    try {
      return await work();
    } finally {
      capabilityOmitted = false;
      await stop();
      omitted = undefined;
      await build();
    }
  }

  async function person(prefix: string): Promise<Person> {
    const key = randomUUID();
    const email = `${key}@account-authz.test`;
    const handle = handleOf(prefix);
    const { accountId } = await required(host, 'Auth host is stopped').workflows.register({
      key: unique(`registration-${prefix}`),
      handle,
      email,
      password,
    });
    partitions.add(partitionOf(route(accountId)));
    return { accountId, email, handle, session: await login(email, loginClient) };
  }
  async function consent(who: Person, clientId: string, requested = scopes, session = who.session) {
    return hostRequest('/consent', { client_id: clientId, scope: requested }, session);
  }
  async function floorOf(accountId: string): Promise<string> {
    const row = await facts.query<{ floor: string }>(
      'SELECT minimum_authn_epoch::text AS floor FROM access.account WHERE route=$1 AND account_id=$2',
      [route(accountId), accountId],
    );
    return required(row.rows[0], 'Missing account').floor;
  }
  async function governorPerson(): Promise<Person> {
    if (!governor) {
      governor = await person('governor');
      await bootstrapGovernance(kernelPool, governor.accountId);
    }
    return governor;
  }
  async function grant(owner: Person, subject: string, action: string, resource = owner.accountId, revoke = false) {
    const actor = await actorFor(await bearer(await login(owner.email, loginClient)));
    const commands = createGrantCommands({ pool: kernelPool, access, managementAction: 'account:manage' });
    await (revoke ? commands.revoke : commands.create)(
      { ...context(), actor },
      {
        resource: { route: route(resource), id: resource },
        subject: { kind: 'account', id: subject },
        actions: [action],
        valid: '(,)',
        key: unique(revoke ? 'revoke' : 'grant'),
      },
    );
  }
  async function refreshTokenFor(session: Headers): Promise<string> {
    const verifier = randomBytes(48).toString('base64url');
    const url = new URL(`${issuer}/authorize`);
    url.search = new URLSearchParams({
      client_id: WEBSITE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid offline_access account:read',
      state: randomUUID(),
      nonce: randomUUID(),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: audience,
    }).toString();
    const authorization = await required(host, 'Auth host is stopped').handler(new Request(url, { headers: session }));
    if (authorization.status !== 302) throw new Error(`Website authorization: ${authorization.status}`);
    const code = required(
      new URL(required(authorization.headers.get('location'), 'Missing redirect')).searchParams.get('code'),
      'Missing authorization code',
    );
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture-website' })
      .setIssuer(WEBSITE_CLIENT_ID)
      .setSubject(WEBSITE_CLIENT_ID)
      .setAudience(issuer)
      .setIssuedAt()
      .setExpirationTime('120s')
      .setJti(randomUUID())
      .sign(websitePair.privateKey);
    const response = await required(host, 'Auth host is stopped').handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: WEBSITE_CLIENT_ID,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
          resource: audience,
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      }),
    );
    return (await successful<{ refresh_token: string }>(response, 'Website token')).refresh_token;
  }

  // ---- native operation translation ------------------------------------------------------------------
  const nativeOperation = (operation: Operation) =>
    operation.kind === 'rename'
      ? {
          kind: 'rename' as const,
          accountId: operation.accountId,
          handle: operation.handle as string,
          expectedHandle: operation.expectedHandle as string | null,
          authorization: 'approval-request',
        }
      : { kind: 'delete' as const, accountId: operation.accountId, authorization: 'approval-request' };
  const recordOf = (operation: Operation) => byOperation.get(operation.key);
  const recordById = (f: Fixture) => required(records.get(f.actorId), 'Unknown fixture');
  async function tokenOf(handle: string): Promise<string> {
    const caller = callers.get(handle);
    if (!caller) return handle;
    const token = await bearer(caller.person.session, caller.requestedBy);
    [...records.values()]
      .find((record) => record.fixture.caller === handle || record.fixture.otherClientCaller === handle)
      ?.bearers.push(token);
    return token;
  }
  const publishReceipt = async (key: string) =>
    (
      await facts.query<{ transaction_id: string }>(
        'SELECT transaction_id::text FROM core.receipt WHERE idempotency_key LIKE $1 ORDER BY created_at LIMIT 1',
        [key],
      )
    ).rows[0]?.transaction_id;

  // ---- automated subjects and credential effects ------------------------------------------------------
  /** The actor's own session, renewed only when recovery or revocation has ended it. */
  async function actorBearer(record: Record_): Promise<string> {
    try {
      return await bearer(record.sessions.actor);
    } catch {
      record.sessions.actor = await login(record.actor.email, record.appClient, scopes, record.password);
      return bearer(record.sessions.actor);
    }
  }
  async function automatedFor(record: Record_): Promise<Automated> {
    const key = unique('automated');
    const handle = handleOf('bot');
    const secret = `automated-${randomUUID()}`;
    const email = `${randomUUID()}@account-authz.test`;
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operatorAccountId: record.actor.accountId,
      handle,
      operationKey: key,
      authorization: 'approval-request',
    };
    const approval = await approvals.approve(await actorBearer(record), { operationKey: key, operation }, context());
    const createdAccount = await required(host, 'Auth host is stopped').workflows.createAutomated({
      key,
      handle,
      operatorAccountId: record.actor.accountId,
      authorization: approval.reference,
      credential: { email, password: secret },
    });
    partitions.add(partitionOf(route(createdAccount.accountId)));
    const subject = { accountId: createdAccount.accountId, email, password: secret };
    record.automated.push(subject);
    await settle(record, [subject.accountId]);
    return subject;
  }
  const subjectOf = async (record: Record_, index = 0) => {
    while (record.automated.length <= index) await automatedFor(record);
    return record.automated[index]!;
  };
  const credentialCall = async (path: string, body: unknown, session: Headers) =>
    answer<Record<string, unknown>>(await hostRequest(path, body, session), path);
  async function stageCredential(record: Record_, subjectId: string, credential: unknown) {
    const staged = await credentialCall(
      '/credential-effects/stage',
      { key: unique('credential'), subjectId, credential },
      record.sessions.actor,
    );
    if ('outcome' in staged) throw new Error('Credential stage was refused');
    return staged.body as unknown as CredentialOperation;
  }
  async function approveCredential(record: Record_, operation: CredentialOperation): Promise<Approval | Denied> {
    const approved = await credentialCall('/credential-effects/approve', operation, record.sessions.actor);
    if ('outcome' in approved) return approved;
    const body = approved.body as { reference: string; expiresAt: string };
    credentialOperations.set(body.reference, operation);
    return { outcome: 'approved', reference: body.reference, expiresAt: body.expiresAt };
  }
  const publicKey = async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    return { kind: 'key' as const, kid, publicJwk: { ...(await exportJWK(pair.publicKey)), alg: 'ES256', kid } };
  };
  const openingReceipt = async (reference: string) => {
    const locator = unseal(referenceKeys, SESSION_OPENING, reference) as
      | { operatorAccountId?: string; receiptId?: string }
      | undefined;
    if (!locator?.operatorAccountId || !locator.receiptId) return undefined;
    return (
      await facts.query<{ expires_at: Date; consumed_transaction_id: string | null }>(
        'SELECT expires_at,consumed_transaction_id::text FROM access.operator_opening_receipt WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3',
        [route(locator.operatorAccountId), locator.operatorAccountId, locator.receiptId],
      )
    ).rows[0];
  };

  // ---- recovery -----------------------------------------------------------------------------------------
  async function startRecovery(email: string, patience = 10_000): Promise<string | undefined> {
    recoveryToken = '';
    await authPool.query('DELETE FROM auth_attempt_counter');
    const started = await hostRequest('/recovery/start', { email });
    if (started.status !== 200) throw new Error(`Recovery start: HTTP ${started.status}`);
    const until = Date.now() + patience;
    while (!recoveryToken && Date.now() < until) await Bun.sleep(10);
    return recoveryToken || undefined;
  }
  /** Completes with a fresh password; the record keeps the password Auth now holds. */
  async function completeRecovery(record: Record_, accountId: string, token: string) {
    const next = `recovered-${randomUUID()}`;
    const response = await hostRequest('/recovery/complete', { account_id: accountId, token, new_password: next });
    if (response.ok && accountId === record.actor.accountId) record.password = next;
    return response;
  }

  // ---- fixtures -------------------------------------------------------------------------------------------
  async function seedFixture(): Promise<Fixture> {
    await governorPerson();
    const appClient = unique('app');
    const otherClient = unique('other');
    for (const clientId of [appClient, otherClient])
      await registerTestClient(service, { clientId, firstParty: false, actions, scopes });
    const [actor, principal, target] = [await person('actor'), await person('principal'), await person('target')];
    for (const who of [actor, principal, target])
      for (const clientId of [appClient, otherClient]) await successful(await consent(who, clientId), 'Auth consent');
    const sessions = {
      actor: await login(actor.email, appClient),
      actorOther: await login(actor.email, otherClient),
      principal: await login(principal.email, appClient),
    };
    // The principal assigns the actor; each of them holds the required right on the target.
    const principalActor = await actorFor(await bearer(sessions.principal));
    const requestId = newId(route(principal.accountId));
    const assignment = await delegations().create(
      { ...context(), actor: principalActor },
      {
        principalId: principal.accountId,
        assignedActorId: actor.accountId,
        requestId,
        valid: '(,)',
        key: unique('assignment'),
      },
    );
    const requestedBy = assignment.value.requestedBy;
    await grant(target, actor.accountId, 'account:update');
    await grant(target, principal.accountId, 'account:update');
    const accessToken = await bearer(sessions.actor, requestedBy);
    const authenticated = await actorFor(accessToken);
    const caller = unique('caller');
    const otherClientCaller = unique('other-client-caller');
    const fixture: Fixture = {
      caller,
      otherClientCaller,
      unauthenticated: unique('unauthenticated'),
      actorId: actor.accountId,
      otherAccountId: principal.accountId,
      clientId: appClient,
      scopes: [...authenticated.scopes],
      requestedBy,
      floor: await floorOf(actor.accountId),
      rawAccessToken: accessToken,
      rawRefreshToken: await refreshTokenFor(sessions.actor),
      operation: {
        kind: 'rename',
        accountId: target.accountId,
        key: unique('operation'),
        handle: handleOf('renamed'),
        expectedHandle: target.handle,
      },
    };
    callers.set(caller, { person: { ...actor, session: sessions.actor }, requestedBy });
    callers.set(otherClientCaller, { person: { ...actor, session: sessions.actorOther }, requestedBy });
    const record: Record_ = {
      fixture,
      actor,
      principal,
      target,
      sessions,
      appClient,
      otherClient,
      requestId,
      bearers: [accessToken],
      approvals: [],
      automated: [],
      pendings: [],
      baseline: new Set(),
      password,
    };
    records.set(fixture.actorId, record);
    byOperation.set(fixture.operation.key, record);
    if (partitions.size < 2) throw new Error('Fixture accounts must cover at least two partitions');
    return fixture;
  }

  type AuthRow = { kind: string; id: string; detail: string | null };
  const rowKey = (row: AuthRow) => `${row.kind}:${row.id}:${row.detail ?? ''}`;
  /** Auth's own durable rows for these accounts: sessions, effects, provisioning, establishment, credentials, keys. */
  async function authRows(ids: string[]): Promise<AuthRow[]> {
    return (
      await authPool.query<AuthRow>(
        `SELECT 'session' AS kind, id, NULL AS detail FROM session WHERE "userId"=ANY($1::text[])
         UNION ALL SELECT 'effect', receipt_id::text, NULL FROM auth_effect_receipt WHERE account_id=ANY($1::text[])
         UNION ALL SELECT 'provision', idempotency_key, account_id FROM auth_provisioning_receipt WHERE account_id=ANY($1::text[])
         UNION ALL SELECT 'establishment', reference, account_id FROM auth_recovery_establishment WHERE account_id=ANY($1::text[])
         UNION ALL SELECT 'credential', id, md5(coalesce(password,'')) FROM account WHERE "userId"=ANY($1::text[])
         UNION ALL SELECT 'consent', client_id, array_to_string(scopes,',') FROM auth_consent WHERE account_id=ANY($1::text[])
         UNION ALL SELECT 'key', kid, account_id FROM auth_public_key WHERE account_id=ANY($1::text[])
         ORDER BY 1,2`,
        [ids],
      )
    ).rows;
  }
  /** What setting an entity up wrote; only later changes count as the tested operation's effects. */
  async function settle(record: Record_, ids: string[]) {
    for (const row of await authRows(ids)) record.baseline.add(rowKey(row));
  }

  async function snapshot(f: Fixture) {
    const record = recordById(f);
    const target = record.target.accountId;
    const receipts = await facts.query<{
      transaction_id: string;
      command_kind: string;
      idempotency_key: string;
      response: unknown;
    }>(
      `SELECT transaction_id::text,command_kind,idempotency_key,response FROM core.receipt
       WHERE partition_no=$1 AND command_kind LIKE 'access.%' AND (response::text LIKE $2 OR idempotency_key LIKE $3)
         AND command_kind NOT LIKE 'access.workflow-approval.%' AND command_kind NOT LIKE 'access.grant.%'
         AND command_kind NOT LIKE 'access.assignment.%' AND command_kind NOT LIKE 'access.role-grant.%'
       ORDER BY transaction_id`,
      [partitionOf(route(target)), `%${target}%`, `%${target}%`],
    );
    const claims = await facts.query(
      `SELECT normalized_handle,state,account_id::text FROM access.handle_claim WHERE account_id=$1 ORDER BY normalized_handle,state`,
      [target],
    );
    const ids = [
      record.actor.accountId,
      record.principal.accountId,
      target,
      ...record.automated.map((subject) => subject.accountId),
      ...record.pendings,
    ];
    const auth = (await authRows(ids)).filter((row) => !record.baseline.has(rowKey(row)));
    const count = (kinds: string[]) => auth.filter((row) => kinds.includes(row.kind)).length;
    return {
      effects: receipts.rows.filter((row) => row.idempotency_key.endsWith(':publish-handle')).length,
      authEffects: count(['session', 'effect', 'provision', 'establishment', 'key']),
      state: { receipts: receipts.rows, claims: claims.rows, auth },
      all: receipts.rows.length,
    };
  }

  async function expiryOf(reference: string): Promise<string | undefined> {
    if (unseal(referenceKeys, APPROVAL_REFERENCE_PURPOSE, reference))
      return (await driver.reference(reference))?.expiresAt;
    if (unseal(referenceKeys, SESSION_OPENING, reference)) {
      const row = await openingReceipt(reference);
      return row ? new Date(row.expires_at).toISOString() : undefined;
    }
    return undefined;
  }

  // ---- the port --------------------------------------------------------------------------------------------
  const driver: AccountAuthorizationDriver = {
    seed: seedFixture,
    async approve(caller, operation) {
      const token = await tokenOf(caller);
      const result = await refused(() =>
        approvals.approve(token, { operationKey: operation.key, operation: nativeOperation(operation) }, context()),
      );
      if ('outcome' in result) return result;
      recordOf(operation)?.approvals.push(result.reference);
      return { outcome: 'approved', reference: result.reference, expiresAt: result.expiresAt } satisfies Approval;
    },
    async reference(referenceValue) {
      const located = unseal(referenceKeys, APPROVAL_REFERENCE_PURPOSE, referenceValue) as
        | { route?: number; id?: string }
        | undefined;
      if (!located?.id || located.route === undefined) return null;
      const row = await facts.query<{
        actor_id: string;
        client_id: string;
        scopes: string[];
        requested_by: string | null;
        operation_key: string;
        operation: { kind: string; accountId: string };
        digest: string;
        expires_at: Date;
      }>(
        'SELECT actor_id::text,client_id,scopes,requested_by,operation_key,operation,digest,expires_at FROM access.workflow_approval WHERE route=$1 AND approval_id=$2',
        [located.route, located.id],
      );
      const found = row.rows[0];
      if (!found) return null;
      return {
        actorId: found.actor_id,
        clientId: found.client_id,
        scopes: found.scopes,
        requestedBy: found.requested_by,
        target: found.operation.accountId,
        purpose: found.operation.kind,
        operationKey: found.operation_key,
        digest: found.digest,
        expiresAt: new Date(found.expires_at).toISOString(),
      };
    },
    async operationDigest(operation) {
      const row = await facts.query<{ digest: string }>(
        'SELECT digest FROM access.workflow_approval WHERE operation_key=$1 ORDER BY created_at DESC LIMIT 1',
        [operation.key],
      );
      return required(row.rows[0], `No native approval digest for ${operation.key}`).digest;
    },
    async execute(referenceValue, operation, checkpoint) {
      const record = recordOf(operation);
      const resolved = await refused(() =>
        approvals.resolve(
          referenceValue as string,
          { ...nativeOperation(operation), operationKey: operation.key },
          context(),
        ),
      );
      if ('outcome' in resolved) return resolved;
      if (operation.kind !== 'rename')
        throw new Error('Account authorization driver cannot execute a delete operation');
      const prefix = required(
        bindings.workflowPorts.approvalBinding!(resolved),
        'Approval has no binding',
      ).commandKeyPrefix;
      const receiptKey = `%:${prefix}:publish-handle`;
      const replayed = (await publishReceipt(receiptKey)) !== undefined;
      let paused = false;
      // The checkpoint changes authority from outside the workflow, not from inside the paused DBOS step.
      const outside = new AsyncResource('account-authorization-checkpoint');
      const listener: StepListener = async (name) => {
        if (!checkpoint || paused || name !== checkpoint.beforeStep) return;
        paused = true;
        await outside.runInAsyncScope(() => checkpoint.run());
        if (record) checkpointBaseline.set(operation.key, (await snapshot(record.fixture)).all);
      };
      stepListeners.add(listener);
      try {
        const result = await refused(() =>
          required(host, 'Auth host is stopped').workflows.renameHandle({
            key: operation.key,
            authorization: referenceValue as string,
            accountId: operation.accountId,
            handle: operation.handle as string,
            expectedHandle: operation.expectedHandle as string | null,
          }),
        );
        if ('outcome' in result) return result;
        const receiptId = required(await publishReceipt(receiptKey), 'Rename completed without a command receipt');
        return { outcome: 'permitted', receiptId, replayed };
      } finally {
        stepListeners.delete(listener);
        restorePrepare?.();
        restorePrepare = undefined;
      }
    },
    async resolveAs(caller, referenceValue, operation) {
      const token = await tokenOf(caller);
      const result = await refused(() =>
        approvals.resolveForCaller(
          token,
          referenceValue,
          { ...nativeOperation(operation), operationKey: operation.key },
          context(),
        ),
      );
      return 'outcome' in result ? result : { outcome: 'permitted' };
    },
    async protectedSteps(operation) {
      const cached = stepsByKind.get(operation.kind);
      if (cached) return cached;
      if (operation.kind !== 'rename') throw new Error('Account authorization driver enumerates rename steps only');
      const f = await seedFixture();
      const approval = await driver.approve(f.caller, f.operation);
      if (approval.outcome !== 'approved') throw new Error('Step enumeration approval was refused');
      const seen: string[] = [];
      const listener: StepListener = async (name) => {
        if (name && !seen.includes(name)) seen.push(name);
      };
      stepListeners.add(listener);
      try {
        const result = await driver.execute(approval.reference, f.operation);
        if (result.outcome !== 'permitted') throw new Error('Step enumeration run was refused');
      } finally {
        stepListeners.delete(listener);
      }
      stepsByKind.set(operation.kind, seen);
      return seen;
    },
    async effectsAfterCheckpoint(f) {
      const baseline = required(checkpointBaseline.get(f.operation.key), 'No checkpoint was reached');
      return (await snapshot(f)).all - baseline;
    },
    async revoke(f, fact: Revocation) {
      const record = recordById(f);
      const { actor, principal, target } = record;
      if (fact === 'actor-grant') await grant(target, actor.accountId, 'account:update', target.accountId, true);
      else if (fact === 'principal-grant')
        await grant(target, principal.accountId, 'account:update', target.accountId, true);
      else if (fact === 'assignment')
        await delegations().revoke(
          { ...context(), actor: await actorFor(await bearer(record.sessions.principal)) },
          { principalId: principal.accountId, requestId: record.requestId, key: unique('assignment-revoke') },
        );
      else if (fact === 'consent')
        await successful(
          await consent(
            actor,
            record.appClient,
            scopes.filter((scope) => scope !== 'account:update'),
            record.sessions.actor,
          ),
          'Auth consent reduction',
        );
      else if (fact === 'epoch')
        await successful(
          await consent(
            actor,
            record.otherClient,
            scopes.filter((scope) => scope !== 'account:read'),
            record.sessions.actorOther,
          ),
          'Auth consent reduction',
        );
      else if (fact === 'scope') {
        const staff = await governorPerson();
        const key = unique('client-reduction');
        const reduced = scopes.filter((scope) => scope !== 'account:update');
        const approval = await approvals.approve(
          await bearer(await login(staff.email, loginClient)),
          {
            operationKey: key,
            operation: {
              kind: 'client-reduction',
              clientId: record.appClient,
              firstParty: false,
              scopes: reduced,
              authorization: 'approval-request',
            },
          },
          context(),
        );
        await required(host, 'Auth host is stopped').workflows.reduceClientScopes({
          key,
          authorization: approval.reference,
          clientId: record.appClient,
          firstParty: false,
          scopes: reduced,
        });
      } else if (fact === 'suspended') {
        const staff = await governorPerson();
        await createSuspensionCommands({ pool: kernelPool, access, clock }).suspend(
          { ...context(), actor: await actorFor(await bearer(await login(staff.email, loginClient))) },
          { accountId: actor.accountId, key: unique('suspend') },
        );
      } else if (fact === 'deleted')
        await bindings.lifecycle.tombstone(
          { ...context(), actor: await actorFor(await bearer(await login(actor.email, record.appClient))) },
          { accountId: actor.accountId, key: unique('tombstone') },
        );
      else if (fact === 'fence')
        await bindings.internalLifecycle.raiseFence({ accountId: actor.accountId, key: unique('fence') });
      else if (fact === 'explicit-deny')
        await facts.query(
          `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
           VALUES ($1,$2,$3,'account:update','resource','(,)',$3)`,
          [route(target.accountId), target.accountId, actor.accountId],
        );
      else if (fact === 'missing-evidence') {
        const prepare = required(access.prepare, 'Access has no evidence reader');
        const unreadable = async (...args: Parameters<typeof prepare>) => {
          await prepare(...args);
          throw new Error('Authoritative evidence is unavailable');
        };
        access.prepare = unreadable;
        restorePrepare = () => {
          if (access.prepare === unreadable) access.prepare = prepare;
        };
      } else if (fact === 'operator-relation') {
        const subject = await subjectOf(record);
        const next = await person('replacement-operator');
        const current = required(
          (
            await facts.query<{ operator_account_id: string; operator_relation_version: string }>(
              'SELECT operator_account_id::text,operator_relation_version::text FROM access.account WHERE route=$1 AND account_id=$2',
              [route(subject.accountId), subject.accountId],
            )
          ).rows[0],
          'Missing automated subject',
        );
        const reservation = await bindings.operators.reserveResponsibility({
          operatorAccountId: next.accountId,
          subjectAccountId: subject.accountId,
          key: unique('operator-change'),
        });
        await bindings.operators.recordOperatorRelation({
          ...reservation.value,
          expectedOperatorAccountId: current.operator_account_id,
          expectedVersion: current.operator_relation_version,
          key: unique('operator-change-record'),
        });
      } else throw new Error(`Unknown revocation ${fact}`);
    },
    async restoreGrant(f) {
      const record = recordById(f);
      await grant(record.target, record.actor.accountId, 'account:update');
    },
    async snapshot(f) {
      const { effects, authEffects, state } = await snapshot(f);
      return { effects, authEffects, state };
    },
    async restart() {
      await stop();
      await build();
    },
    async restartAccessReader() {
      // A fresh Access composition: no JWKS, permission or epoch cache survives.
      reader = testKernel({
        pool: kernelPool,
        actions,
        tokens: referenceKeys,
        clock,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }).testAccess;
    },
    async awaitExpiry(referenceValue) {
      const expiresAt = required(await expiryOf(referenceValue), 'Cannot locate the native expiry of this reference');
      advancedMs += Math.max(0, Date.parse(expiresAt) - clock().getTime()) + 1000;
    },
    async signInAutomated(f, credential) {
      const record = recordById(f);
      const subject = await subjectOf(record);
      const second = await subjectOf(record, 1);
      const secret = credential === 'own' ? subject.password : credential === 'other' ? second.password : undefined;
      const response = await hostRequest('/signin', {
        email: subject.email,
        ...(secret === undefined ? {} : { password: secret }),
        client_id: loginClient,
        scope: scopes,
      });
      const result = await answer<unknown>(response, 'Automated sign-in');
      return 'outcome' in result ? result : { outcome: 'permitted' };
    },
    async opening(f, purpose) {
      const record = recordById(f);
      const subject = await subjectOf(record);
      if (purpose === 'session') {
        // A session opening is taken through the first-party login client, which an automated subject may use.
        const actor = await actorFor(await bearer(record.actor.session));
        const opened = await bindings.workflowPorts.authorizeOpening!(
          { ...context(), actor },
          {
            operatorAccountId: record.actor.accountId,
            subjectAccountId: subject.accountId,
            purpose: 'session',
            key: unique('opening'),
          },
        );
        const reference = opened.value.receiptId;
        openings.set(reference, { purpose, subject });
        return {
          outcome: 'approved',
          reference,
          expiresAt: new Date(
            required(await openingReceipt(reference), 'Opening was not stored').expires_at,
          ).toISOString(),
        };
      }
      const credential =
        purpose === 'set-password'
          ? { kind: 'password', password: `candidate-${randomUUID()}` }
          : purpose === 'remove-password'
            ? { kind: 'password', password: null }
            : purpose === 'add-key'
              ? await publicKey()
              : await installedKey(record, subject);
      const approved = await approveCredential(record, await stageCredential(record, subject.accountId, credential));
      if (approved.outcome !== 'approved') throw new Error('Credential opening was refused');
      openings.set(approved.reference, { purpose, subject });
      return approved;
    },
    async consumeOpening(f, referenceValue, mismatch) {
      const record = recordById(f);
      const opening = required(openings.get(referenceValue), 'Unknown opening reference');
      const second = await subjectOf(record, 1);
      const isSession = opening.purpose === 'session' && mismatch !== 'purpose';
      const session =
        mismatch === 'human'
          ? isSession
            ? record.principal.session
            : record.sessions.principal
          : mismatch === 'client'
            ? record.sessions.actorOther
            : isSession
              ? record.actor.session
              : record.sessions.actor;
      const subject = mismatch === 'subject' ? second : opening.subject;
      if (isSession) {
        const response = await refused(() =>
          service.internal.openAutomatedSession({
            authorization: referenceValue,
            subjectAccountId: subject.accountId,
            headers: session,
          }),
        );
        if ('outcome' in response) return response;
        const result = await answer<unknown>(response, 'Session opening');
        if ('outcome' in result) return result;
        const row = await openingReceipt(referenceValue);
        return {
          outcome: 'permitted',
          receiptId: required(row?.consumed_transaction_id ?? undefined, 'Opening was not consumed'),
        };
      }
      // A credential consumer presents the opening with the staged effect its exact purpose names.
      const operation =
        mismatch === 'remove-key'
          ? await stageCredential(record, subject.accountId, await installedKey(record, subject))
          : mismatch === 'purpose'
            ? await stageCredential(record, subject.accountId, {
                kind: 'password',
                password: `candidate-${randomUUID()}`,
              })
            : required(credentialOperations.get(referenceValue), 'Opening has no staged credential effect');
      const applied = await credentialCall(
        '/credential-effects/apply',
        { ...operation, subjectId: subject.accountId, reference: referenceValue },
        session,
      );
      if ('outcome' in applied) return applied;
      return permitted((applied.body as { receiptId?: string }).receiptId);
    },
    async pendingProof(f, state) {
      const record = recordById(f);
      const registrationKey = unique('registration-pending');
      const handle = handleOf('pending');
      if (state === 'reservation-only') {
        const accountId = bindings.internalLifecycle.registrationTarget(registrationKey);
        const reservation = await bindings.internalLifecycle.reserveHandle({ accountId, handle, key: registrationKey });
        record.pendings.push(accountId);
        return sealedPending({
          accountId,
          key: registrationKey,
          handle,
          reservationId: reservation.value.reservationId,
          expiresAt: reservation.value.expiresAt,
        });
      }
      if (state === 'rolled-back' || state === 'uncommitted')
        return heldPending(record, registrationKey, handle, state);
      const pending = await required(host, 'Auth host is stopped').workflows.beginRegistration({
        key: registrationKey,
        handle,
      });
      record.pendings.push(pending.accountId);
      await settle(record, [pending.accountId]);
      const stage = required(
        (
          await authPool.query<{ reservation_id: string }>(
            'SELECT reservation_id FROM auth_registration_stage WHERE registration_id=$1',
            [pending.registrationId],
          )
        ).rows[0],
        'Missing registration stage',
      );
      const reference = await bindings.workflowPorts.provisioningReference!({
        accountId: pending.accountId,
        reservationId: stage.reservation_id,
      });
      const located = unseal(referenceKeys, REGISTRATION_PROOF, reference) as Record<string, unknown>;
      if (state === 'committed') return reference;
      if (state === 'expired') {
        expiredPendings.add(reference);
        return reference;
      }
      if (state === 'wrong-kind') return sealedPending({ ...located, key: `${located.key}:activate` });
      if (state === 'other-account')
        return sealedPending({ ...located, accountId: (await subjectOf(record)).accountId });
      return sealedPending({
        ...located,
        transactionId: newId(route(pending.accountId)),
        position: '9007199254740991',
      });
    },
    async provision(_f, referenceValue) {
      // The pending registration lasts thirty minutes; its expiry is reached by moving the clock, then restored.
      const before = advancedMs;
      if (expiredPendings.has(referenceValue)) advancedMs += 31 * 60_000;
      try {
        const result = await refused(() =>
          service.internal.provisionPassword({
            authorization: referenceValue,
            email: `${randomUUID()}@account-authz.test`,
            password: `provisioned-${randomUUID()}`,
          }),
        );
        return 'outcome' in result ? result : { outcome: 'permitted' };
      } finally {
        advancedMs = before;
      }
    },
    async barrier(f, kind, fault, beforeAuth) {
      const record = recordById(f);
      const wrap: BarrierWrap = { fault, kind, beforeAuth, observed: undefined, target: record.target.accountId };
      barrierWrap = wrap;
      const settle = async (response: Response, label: string) => {
        if (wrap.error !== undefined) throw wrap.error;
        const result = await answer<unknown>(response, label);
        return 'outcome' in result ? result : permitted(wrap.observed?.receiptId);
      };
      try {
        if (kind === 'consent') {
          const response = await consent(
            record.actor,
            record.appClient,
            scopes.filter((scope) => scope !== 'account:read'),
            record.sessions.actor,
          );
          return await settle(response, 'Consent barrier');
        }
        await bindings.internalLifecycle.raiseFence({
          accountId: record.actor.accountId,
          key: unique('recovery-fence'),
        });
        f.floor = await floorOf(record.actor.accountId);
        const token = required(await startRecovery(record.actor.email), 'Recovery was not delivered');
        const recovered = await completeRecovery(record, record.actor.accountId, token);
        return await settle(recovered, 'Recovery barrier');
      } finally {
        barrierWrap = undefined;
      }
    },
    async fence(accountId) {
      const state = await bindings.internalLifecycle.readFenceState(accountId);
      return state?.receiptId
        ? { receiptId: state.receiptId, floor: String(state.minimumAuthnEpoch), fenced: state.fenced }
        : null;
    },
    async oldSessionAllowed(f) {
      try {
        await actorFor(f.rawAccessToken, reader);
        return true;
      } catch (error) {
        if (refusal(error) || (error instanceof Error && error.name.includes('Authentication'))) return false;
        throw error;
      }
    },
    async withoutCapability(f, capability) {
      if (capability === 'authorizeOperation') {
        const approval = await driver.approve(f.caller, f.operation);
        if (approval.outcome !== 'approved') throw new Error('Approval was refused');
        return without(capability, () => driver.execute(approval.reference, f.operation));
      }
      if (capability === 'verifyProvisioningReceipt') {
        const reference = await driver.pendingProof(f, 'committed');
        return without(capability, () => driver.provision(f, reference));
      }
      if (capability === 'consumeAuthAuthorization') {
        const opened = await driver.opening(f, 'session');
        return without(capability, () => driver.consumeOpening(f, opened.reference));
      }
      return without(capability, () => driver.barrier(f, capability === 'invalidateAccount' ? 'consent' : 'recovery'));
    },
    async nativeException(f, scenario) {
      const record = recordById(f);
      const session = () => login(record.actor.email, record.appClient, scopes, record.password);
      const read = async (accountId: string) => {
        const actor = await actorFor(await bearer(await session()));
        const check = await accessCheck(
          access,
          actor,
          'account:read',
          { route: route(accountId), id: accountId },
          context(),
        );
        return (
          await runCommand(kernelPool, { partition: partitionOf(route(accountId)) }, async (tx, { time }) => ({
            value: await check(tx, time),
            events: [{ type: 'com.rezics.test.checked.v1', data: {} }],
          }))
        ).value;
      };
      if (scenario === 'self-read') return (await read(record.actor.accountId)) ? { outcome: 'permitted' } : denied;
      if (scenario === 'other-account-read')
        return (await read(record.target.accountId)) ? { outcome: 'permitted' } : denied;
      const subject = scenario === 'automated-recovery' ? await subjectOf(record) : undefined;
      const organization = scenario === 'organization-recovery' ? await organizationFor(record) : undefined;
      await bindings.internalLifecycle.raiseFence({
        accountId: record.actor.accountId,
        key: unique(`${scenario}-fence`),
      });
      if (scenario === 'generic-write') {
        const signed = await hostRequest('/signin', {
          email: record.actor.email,
          password: record.password,
          client_id: record.appClient,
          scope: scopes,
        });
        const answered = await answer<unknown>(signed.clone(), 'Fenced sign-in');
        if ('outcome' in answered) return answered;
        const written = await refused(async () =>
          approvals.approve(
            await bearer(cookies(signed)),
            { operationKey: unique('fenced-write'), operation: nativeOperation(record.fixture.operation) },
            context(),
          ),
        );
        return 'outcome' in written ? written : { outcome: 'permitted' };
      }
      // Recovery always starts from a mailed token for an account that has one; Auth mints none for others.
      const token = await startRecovery(subject?.email ?? record.actor.email, subject ? 3000 : 10_000);
      if (!token) return scenario === 'fenced-human-recovery' || scenario === 'stale-recovery' ? unavailable() : denied;
      if (scenario === 'stale-recovery')
        await bindings.internalLifecycle.raiseFence({ accountId: record.actor.accountId, key: unique('stale-fence') });
      const accountId = organization ?? record.actor.accountId;
      const result = await answer<unknown>(await completeRecovery(record, accountId, token), 'Native recovery');
      return 'outcome' in result ? result : { outcome: 'permitted' };
    },
    async durableState(f) {
      const record = recordById(f);
      const rows = await authPool.query<{ text: string }>(
        `SELECT inputs::text AS text FROM auth_dbos.workflow_status WHERE inputs IS NOT NULL
         UNION ALL SELECT output::text FROM auth_dbos.workflow_status WHERE output IS NOT NULL
         UNION ALL SELECT error::text FROM auth_dbos.workflow_status WHERE error IS NOT NULL
         UNION ALL SELECT output::text FROM auth_dbos.operation_outputs WHERE output IS NOT NULL
         UNION ALL SELECT error::text FROM auth_dbos.operation_outputs WHERE error IS NOT NULL
         UNION ALL SELECT request::text FROM auth_workflow_request`,
      );
      const texts = rows.rows.map((row) => row.text);
      const has = (secret: string) => texts.some((text) => text.includes(secret));
      const jwt = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
      return {
        records: texts.length,
        references: record.approvals.filter(has).length,
        accessTokens: record.bearers.filter(has).length + texts.filter((text) => jwt.test(text)).length,
        refreshTokens: has(record.fixture.rawRefreshToken) ? 1 : 0,
        plaintextCredentials: has(password) || record.automated.some((subject) => has(subject.password)) ? 1 : 0,
        actorContexts: texts.filter(carriesActorContext).length,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        for (const pending of held) pending.release();
        await Promise.allSettled(held.map((pending) => pending.done));
        await stop();
      } finally {
        advancedMs = 0;
        await facts?.end().catch(() => {});
        await kernelPool?.end().catch(() => {});
        for (const name of created.reverse()) {
          const deadline = Date.now() + 5000;
          for (;;) {
            try {
              await admin.query(`DROP DATABASE "${name}"`);
              break;
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== '55006' || Date.now() >= deadline)
                throw error;
              await Bun.sleep(25);
            }
          }
        }
        await admin.end();
      }
    },
  };

  // ---- helpers that need the port ---------------------------------------------------------------------------
  async function installedKey(record: Record_, subject: Automated) {
    const key = await publicKey();
    const operation = await stageCredential(record, subject.accountId, key);
    const approved = await approveCredential(record, operation);
    if (approved.outcome !== 'approved') throw new Error('Key installation was refused');
    const applied = await credentialCall(
      '/credential-effects/apply',
      { ...operation, reference: approved.reference },
      record.sessions.actor,
    );
    if ('outcome' in applied) throw new Error('Key installation was refused');
    return { kind: 'key' as const, kid: key.kid, remove: true as const };
  }
  function sealedPending(value: Record<string, unknown>) {
    return seal(referenceKeys, REGISTRATION_PROOF, {
      epoch: 1,
      position: '1',
      transactionId: newId(route(value.accountId as string)),
      ...value,
    });
  }
  /** A real createPending command whose transaction never commits: held open, or rolled back. */
  async function heldPending(record: Record_, key: string, handle: string, state: 'rolled-back' | 'uncommitted') {
    const accountId = bindings.internalLifecycle.registrationTarget(key);
    const reservation = await bindings.internalLifecycle.reserveHandle({ accountId, handle, key });
    record.pendings.push(accountId);
    const holdPool = createPool(connection(kernelName));
    const connect = holdPool.connect.bind(holdPool) as () => Promise<PoolClient>;
    const identity: { transactionId?: string; epoch?: number; position?: string } = {};
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let announce = () => {};
    const reached = new Promise<void>((resolve) => (announce = resolve));
    (holdPool as unknown as { connect: () => Promise<PoolClient> }).connect = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      client.query = (async (...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string }).text;
        if (text === 'COMMIT' && identity.epoch !== undefined) {
          announce();
          if (state === 'uncommitted') await gate;
          await query('ROLLBACK');
          throw new Error('The held command transaction was discarded');
        }
        const result = (await query(...args)) as { rows?: { epoch?: number; position?: string }[] };
        const row = result?.rows?.[0];
        if (row && typeof row.epoch === 'number' && row.position !== undefined) {
          identity.epoch = row.epoch;
          identity.position = String(row.position);
          const values = (Array.isArray(args[1]) ? args[1] : (args[0] as { values?: unknown[] }).values) ?? [];
          const transactionId = values.find(
            (value): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(value),
          );
          if (transactionId) identity.transactionId = transactionId;
        }
        return result;
      }) as typeof client.query;
      return client;
    };
    const lifecycle = createLifecycleInternals({
      pool: holdPool,
      routeKey,
      clock,
      provisioningEvidence: async () => null,
      recoveryEvidence: async () => null,
    });
    const command = lifecycle
      .createPending({ accountId, handle, reservationId: reservation.value.reservationId, key })
      .catch(() => undefined);
    held.push({ release, done: command.finally(() => holdPool.end().catch(() => {})) });
    await reached;
    return sealedPending({
      accountId,
      key,
      handle,
      reservationId: reservation.value.reservationId,
      expiresAt: reservation.value.expiresAt,
      ...(identity.epoch === undefined ? {} : { epoch: identity.epoch }),
      ...(identity.position === undefined ? {} : { position: identity.position }),
      ...(identity.transactionId === undefined ? {} : { transactionId: identity.transactionId }),
    });
  }
  async function organizationFor(record: Record_): Promise<string> {
    if (record.organization) return record.organization;
    const organizationId = newId(route(record.principal.accountId));
    const reservation = await bindings.internalLifecycle.reserveCoordination({
      accountId: record.principal.accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: unique('organization-owner'),
    });
    await bindings.internalLifecycle.createOrganization({
      organizationId,
      ownerAccountId: record.principal.accountId,
      ownerReservationId: reservation.value.reservationId,
      key: unique('organization'),
    });
    return (record.organization = organizationId);
  }

  try {
    await admin.query(`CREATE DATABASE "${kernelName}" TEMPLATE "${template}"`);
    created.push(kernelName);
    await createAuthDatabase(source.href, authName);
    created.push(authName);
    kernelPool = createPool(connection(kernelName));
    facts = new Pool({ connectionString: connection(kernelName) });
    await build();
    await registerTestClient(service, { clientId: loginClient, firstParty: true, actions, scopes });
    await service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [{ ...(await exportJWK(websitePair.publicKey)), kid: 'fixture-website', alg: 'ES256', use: 'sig' }],
      } as PublicJwks,
      redirectUris: [redirectUri],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: ['openid', 'offline_access', 'account:read', 'media:complete'],
    });
  } catch (error) {
    await driver.close();
    throw error;
  }
  return driver;
}

/** True when a serialized durable value parses to an actor or request context rather than a business operand. */
function carriesActorContext(text: string): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if ('actor' in record && typeof record.actor === 'object') return true;
    if (Array.isArray(record.scopes) && ('clientId' in record || 'accountId' in record || 'authnEpoch' in record))
      return true;
    if ('authnEpoch' in record && 'requestedBy' in record) return true;
    return Object.values(record).some(visit);
  };
  try {
    return visit(JSON.parse(text));
  } catch {
    return false;
  }
}
