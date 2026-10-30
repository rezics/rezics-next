import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createAccountWorkflows,
  createAuthService,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Pool } from 'pg';
import type {
  Account,
  AccountLifecycleDriver,
  Credential,
  FenceReceipt,
  Login,
  Outcome,
  PublicView,
  Session,
  Token,
} from '../../../../specs/account-lifecycle-driver.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { credentialEffectTransport } from '../../../auth/src/host.ts';
import { accountOperationTransport } from '../../../auth/src/account-operations-transport.ts';
import { readAccount, readPublicAccount } from '../../src/access/account-data.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { COMMITTED_CONTINUATION_ACTIONS, ContinuationDeniedError } from '../../src/access/committed-continuations.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import {
  createWorkflowApprovals,
  WORKFLOW_APPROVAL_ACTIONS,
  WorkflowApprovalDeniedError,
} from '../../src/access/workflow-approvals.ts';
import { ApprovalIdentityDeniedError } from '../../src/access/approved-identity.ts';
import { AuthBindingDeniedError } from '../../src/access/auth-bindings.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { OperatorDeniedError } from '../../src/access/operator.ts';
import { ResourceAccessWriteDeniedError } from '../../src/access/resource-denials.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { AuthenticationError, type AccessContext } from '../../src/request/access.ts';
import { newId, ROUTES, routeOf } from '../../src/route/route.ts';
import { registerTestClient, testKernel, testRouteKey, type TestKernel } from '../support/test-kernel.ts';

const RESOURCE_ACTION = 'lifecycle_fixture:use';
const scopes = [
  ...new Set([
    ...LIFECYCLE_ACTIONS.keys(),
    ...COMMITTED_CONTINUATION_ACTIONS.keys(),
    ...WORKFLOW_APPROVAL_ACTIONS.keys(),
    'account:manage',
    'account:read',
    'account:update',
    'account:delete',
    'account:suspend',
    'access:grant',
    'access:delegate',
    'organization:create',
    'organization:membership',
    RESOURCE_ACTION,
  ]),
].sort();
const AUTHORIZATION = 'lifecycle-approval-request';
const OPEN_INTERVAL = '(,)';
const WAIT_FOR_RECOVERY_DELIVERY_MS = 4000;

type Caller = { readonly headers: Headers; readonly accountId: string };
type Person = { accountId: string };
type StoredCredential =
  | { kind: 'password'; email: string; password: string }
  | { kind: 'key'; kid: string; publicJwk: JWK; privateKey: CryptoKey };

const required = <T>(value: T | null | undefined, description: string): T => {
  if (value == null) throw new Error(description);
  return value;
};
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; '),
  });
const callerOf = (session: Session) => required(session.opaque as Caller | undefined, 'Foreign session handle');
const credentialOf = (credential: Credential) =>
  required(credential.opaque as StoredCredential | undefined, 'Foreign credential handle');

/** A real product refusal: every native command and workflow refusal carries status 403 or a named denial. */
function isRefusal(error: unknown): boolean {
  if (
    error instanceof LifecycleDeniedError ||
    error instanceof GrantDeniedError ||
    error instanceof OperatorDeniedError ||
    error instanceof ContinuationDeniedError ||
    error instanceof AuthBindingDeniedError ||
    error instanceof WorkflowApprovalDeniedError ||
    error instanceof ApprovalIdentityDeniedError ||
    error instanceof ResourceAccessWriteDeniedError
  )
    return true;
  if (typeof error !== 'object' || error === null) return false;
  if ('status' in error && error.status === 403) return true;
  if ('code' in error && (error.code === 'handle_unavailable' || error.code === 'registration_denied')) return true;
  return error instanceof Error && error.message === 'Account workflow denied';
}
async function refused<T>(work: () => Promise<T>): Promise<T | 'denied'> {
  try {
    return await work();
  } catch (error) {
    if (isRefusal(error)) return 'denied';
    throw error;
  }
}

async function openDriver(): Promise<AccountLifecycleDriver> {
  const source = new URL(required(process.env.DATABASE_URL, 'DATABASE_URL must name a migrated kernel database'));
  const template = source.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(template)) throw new Error('Unsafe template database name');
  const suffix = randomUUID().replaceAll('-', '');
  const kernelName = `lifecycle_kernel_${suffix}`;
  const authName = `lifecycle_auth_${suffix}`;
  const connection = (name: string) => {
    const url = new URL(source);
    url.pathname = `/${name}`;
    return url.href;
  };
  const issuer = `https://lifecycle-${suffix}.auth.test`;
  const audience = 'https://lifecycle.api.test';
  const clientId = `lifecycle-${suffix}`;
  const routeKey = testRouteKey();
  const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const stagingKey = randomBytes(32);
  const secret = randomBytes(48).toString('base64url');
  const actions = new Map([...LIFECYCLE_ACTIONS, ...COMMITTED_CONTINUATION_ACTIONS, ...actionDeclarations(scopes)]);
  const signing = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)) } as JWK;
  signing.kid = `lifecycle-${suffix}`;

  // Time is the kernel clock. It follows real time until advanceTo moves it forward.
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);

  const admin = new Pool({ connectionString: connection('postgres') });
  const owned: string[] = [];
  let kernel: ReturnType<typeof createPool> | undefined;
  let authPool: Pool | undefined;
  let service: AuthService | undefined;
  let workflows: ReturnType<typeof createAccountWorkflows> | undefined;
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let kernelHttp: TestKernel | undefined;
  let bindings: ReturnType<typeof createNativeAccountBindings> | undefined;
  let approvals: ReturnType<typeof createWorkflowApprovals> | undefined;
  let governor: (Person & { caller: Caller }) | undefined;

  // Hooks around Auth's session revocation, installed per revokeSessions call.
  let beforeRevocation: (() => Promise<void>) | undefined;
  let revocationOutage = false;
  const hook: { failure?: { error: unknown } } = {};
  // Delivered recovery tokens, by account.
  const recoveries = new Map<string, string[]>();
  const registrations = new Map<string, string>();
  const emails = new Map<string, string>();
  const grantedCreators = new Set<string>();
  // Destination acceptances awaiting the source's transfer, by `${subject}:${destination}`.
  const acceptances = new Map<string, { operationKey: string; reference: string }>();

  const hookFailure = () => hook.failure;
  const outage = () => revocationOutage;
  const db = () => required(kernel, 'Kernel database is closed');
  const authDb = () => required(authPool, 'Auth database is closed');
  const auth = () => required(service, 'Auth service is stopped');
  const wf = () => required(workflows, 'Auth workflows are stopped');
  const native = () => required(bindings, 'Native account bindings are unavailable');
  const access = () => required(kernelHttp, 'Kernel is stopped').testAccess;
  const approve = () => required(approvals, 'Workflow approvals are unavailable');
  const boundary = () => ({ pool: db(), deadline: Date.now() + 20_000 });
  const label = (prefix: string) => `${prefix}-${randomUUID()}`;
  const route = (id: string) => required(routeOf(id), `Invalid account id: ${id}`);

  async function post(path: string, body: unknown, caller?: Caller): Promise<Response> {
    return required(
      handler,
      'Auth host is stopped',
    )(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: caller?.headers.get('cookie') ?? '' },
        body: JSON.stringify(body),
      }),
    );
  }
  async function get(path: string, caller: Caller): Promise<Response> {
    return required(
      handler,
      'Auth host is stopped',
    )(new Request(`${issuer}${path}`, { headers: { origin: issuer, cookie: caller.headers.get('cookie') ?? '' } }));
  }
  /** An Auth refusal is 4xx; anything else that is not success is infrastructure. */
  async function settle(response: Response, description: string): Promise<Response | 'denied'> {
    if (response.ok) return response;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) return 'denied';
    throw new Error(`${description}: HTTP ${response.status}: ${await response.text()}`);
  }
  async function bearer(caller: Caller): Promise<string | 'denied'> {
    const response = await settle(await post('/token', {}, caller), 'Auth token issuance');
    if (response === 'denied') return 'denied';
    return required(((await response.json()) as { access_token?: string }).access_token, 'Auth issued no access token');
  }
  async function requiredBearer(caller: Caller): Promise<string> {
    const token = await bearer(caller);
    if (token === 'denied') throw new Error('Auth refused a fixture token');
    return token;
  }
  async function context(token: string) {
    const bounded = boundary();
    return { ...bounded, actor: await access().authenticate(token, bounded) };
  }
  async function actorContext(caller: Caller) {
    const ctx = await context(await requiredBearer(caller));
    return { ...ctx, account: await readAccount(db(), route(ctx.actor.accountId), ctx.actor.accountId) };
  }
  const grantsFor = (managementAction: string) =>
    createGrantCommands({ pool: db(), access: access(), clock, managementAction });

  async function signInPassword(accountId: string, password: string): Promise<Response> {
    return post('/signin', { account_id: accountId, password, client_id: clientId, scope: scopes });
  }
  async function signedAssertion(accountId: string, key: Extract<StoredCredential, { kind: 'key' }>) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: key.kid })
      .setIssuer(accountId)
      .setSubject(accountId)
      .setAudience(`${issuer}/token`)
      .setIssuedAt(now)
      .setExpirationTime(now + 50)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  const build = async () => {
    authPool = new Pool({ connectionString: connection(authName) });
    kernel = createPool(connection(kernelName));
    kernelHttp = testKernel({
      pool: db(),
      actions,
      tokens: referenceKeys,
      clock,
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => auth().handler(new Request(`${issuer}/.well-known/jwks.json`)),
      },
      writeRate: createWriteRateLimiter({ secret }),
    });
    const proofs = createNativeWorkflowProofPorts({ database: authDb() });
    bindings = createNativeAccountBindings({
      pool: db(),
      access: access(),
      actions,
      routeKey,
      clock,
      referenceKeys,
      auth: () => auth(),
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: authDb() }),
        barriers: createBarrierProofVerifier({ database: authDb() }),
        recoveryEvidence: (reference) => auth().internal.resolveRecoveryEstablishment(reference),
      },
    });
    approvals = createWorkflowApprovals({
      pool: db(),
      access: access(),
      actions,
      referenceKeys,
      creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
    });
    service = await createAuthService({
      database: authDb(),
      issuer,
      audience,
      secret,
      signing: { activeKid: signing.kid!, privateKeys: [signing] },
      siteActions: actions,
      trustedAccess: native().trustedAccess,
      recoveryDelivery: {
        async deliver(input) {
          recoveries.set(input.accountId, [...(recoveries.get(input.accountId) ?? []), input.token]);
        },
      },
    });
    const real = auth();
    workflows = createAccountWorkflows({
      database: authDb(),
      systemDatabaseUrl: connection(authName),
      systemDatabaseSchemaName: 'auth_dbos',
      systemDatabasePool: authDb(),
      stagingKey,
      // Only the Auth outage and the observation hook wrap the real revocation.
      auth: {
        ...real,
        internal: {
          ...real.internal,
          async revokeSessions(accountId, options) {
            if (beforeRevocation) {
              try {
                await beforeRevocation();
              } catch (error) {
                hook.failure = { error };
                throw error;
              }
            }
            if (revocationOutage) throw new Error('Injected Auth outage');
            return real.internal.revokeSessions(accountId, options);
          },
        },
      },
      access: native().workflowPorts,
      clock,
      executorId: `lifecycle-${suffix}`,
      handleSignals: false,
    });
    handler = accountOperationTransport(
      real,
      wf(),
      credentialEffectTransport(real, wf().handler, { database: authDb(), secret }),
      undefined,
    );
    await wf().start();
    await real.internal.registerClient({ clientId: 'login', firstParty: true, scopes: [] });
    await registerTestClient(real, { clientId, firstParty: true, actions, scopes });
  };
  const close = async () => {
    try {
      await workflows?.close();
    } finally {
      workflows = undefined;
      handler = undefined;
      service = undefined;
      await authPool?.end().catch(() => {});
      authPool = undefined;
      await kernel?.end().catch(() => {});
      kernel = undefined;
      for (const name of owned.reverse()) {
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
            break;
          } catch (error) {
            // Pool.end can resolve before its sockets finish disconnecting.
            if (!(error instanceof Error) || !('code' in error) || error.code !== '55006' || Date.now() >= deadline)
              throw error;
            await Bun.sleep(25);
          }
        }
      }
      owned.length = 0;
      await admin.end().catch(() => {});
    }
  };
  let closing: Promise<void> | undefined;
  const closeOnce = () => (closing ??= close());
  try {
    await admin.query(`CREATE DATABASE "${kernelName}" TEMPLATE "${template}"`);
    owned.push(kernelName);
    await admin.query(`CREATE DATABASE "${authName}"`);
    owned.push(authName);
    migrateAuth(connection(authName), fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
    await build();
  } catch (error) {
    await closeOnce();
    throw error;
  }

  // Fixture people: registered through the real workflow, then promoted to governor once.
  async function fixturePerson(prefix: string): Promise<Person & { caller: Caller }> {
    const key = label(prefix);
    const password = `fixture-${randomUUID()}`;
    const registered = await wf().register({
      key,
      handle: `${prefix}_${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@lifecycle-fixture.test`,
      password,
    });
    const response = await settle(await signInPassword(registered.accountId, password), 'fixture sign-in');
    if (response === 'denied') throw new Error('Fixture sign-in was refused');
    return { accountId: registered.accountId, caller: { headers: cookies(response), accountId: registered.accountId } };
  }
  async function platform() {
    if (!governor) {
      governor = await fixturePerson('platform');
      await bootstrapGovernance(db(), governor.accountId);
    }
    return governor;
  }
  /** Fixture setup: the platform governor grants through the real grant command. */
  async function governorGrant(resourceId: string, subjectId: string, granted: string[]) {
    const staff = await platform();
    const ctx = await actorContext(staff.caller);
    await grantsFor('access:grant').create(ctx, {
      resource: { route: route(resourceId), id: resourceId },
      subject: { kind: 'account', id: subjectId },
      actions: granted,
      valid: OPEN_INTERVAL,
      key: label('fixture-grant'),
    });
  }
  async function approved(caller: Caller, operationKey: string, operation: Record<string, unknown>) {
    const token = await requiredBearer(caller);
    return approve().approve(
      token,
      { operationKey, operation: { ...operation, authorization: AUTHORIZATION } as never },
      boundary(),
    );
  }
  async function accountRow(id: string) {
    return required(await readAccount(db(), route(id), id), `Unknown account ${id}`);
  }
  async function responsibilityOf(subjectId: string) {
    const row = (
      await db().query<{ operator_account_id: string | null; operator_reservation_id: string | null; version: string }>(
        'SELECT operator_account_id::text,operator_reservation_id::text,operator_relation_version::text AS version FROM access.account WHERE route=$1 AND account_id=$2',
        [route(subjectId), subjectId],
      )
    ).rows[0];
    return row;
  }
  /** The responsibility record a transfer names, read from the persisted account. */
  async function transferRecord(caller: Caller, id: string) {
    const current = await responsibilityOf(id);
    return {
      previous: {
        operatorAccountId: current?.operator_account_id ?? caller.accountId,
        subjectAccountId: id,
        reservationId: current?.operator_reservation_id ?? newId(route(id)),
      },
      expectedVersion: current?.version ?? '0',
    };
  }
  async function openingFor(actingHuman: Session, subjectId: string): Promise<Login> {
    const human = callerOf(actingHuman);
    const humanId = human.accountId;
    const subject = await responsibilityOf(subjectId);
    const operatorAccountId = subject?.operator_account_id ?? humanId;
    const key = label('opening');
    const result = await refused(async () => {
      const token = await bearer(human);
      if (token === 'denied') return 'denied' as const;
      const approval = await approve().approve(
        token,
        {
          operationKey: key,
          operation: { kind: 'opening', operatorAccountId, subjectAccountId: subjectId, authorization: AUTHORIZATION },
        },
        boundary(),
      );
      return wf().openOperatorSession({
        key,
        authorization: approval.reference,
        operatorAccountId,
        subjectAccountId: subjectId,
        headers: human.headers,
      });
    });
    if (result === 'denied') return { outcome: 'denied' };
    const settled = await settle(result, 'operator session opening');
    if (settled === 'denied') return { outcome: 'denied' };
    return remember(subjectId, cookies(settled));
  }
  /** Sessions this driver has handed out, so privileged fixture setup can act through a real one. */
  const latest = new Map<string, Caller>();
  function remember(accountId: string, headers: Headers): Login {
    const caller: Caller = { headers, accountId };
    latest.set(accountId, caller);
    return { outcome: 'authenticated', session: { opaque: caller } };
  }
  async function readSessionProof(caller: Caller) {
    const response = await settle(await get('/session', caller), 'Auth session proof');
    if (response === 'denied') throw new Error('Auth refused a session proof');
    return (await response.json()) as { account_id: string; authn_epoch: number };
  }
  async function reservationOf(accountId: string, organizationId: string) {
    const row = (
      await db().query<{ reservation_id: string }>(
        `SELECT reservation_id::text FROM access.lifecycle_coordination
         WHERE route=$1 AND account_id=$2 AND related_account_id=$3 AND purpose='membership' ORDER BY reservation_id LIMIT 1`,
        [route(accountId), accountId, organizationId],
      )
    ).rows[0];
    return row?.reservation_id;
  }

  const driver: AccountLifecycleDriver = {
    close: closeOnce,
    async advanceTo(instant) {
      const target = Date.parse(instant);
      if (!Number.isFinite(target)) throw new Error(`Invalid instant ${instant}`);
      offset = Math.max(offset, target - Date.now());
      await wf().expireDueRegistrations();
    },
    async beginRegistration(input) {
      if (input.kind !== undefined) {
        // The public registration form has no kind field; the product answers the closed body with a refusal.
        const response = await post('/signup', {
          key: input.key,
          handle: input.handle,
          kind: input.kind,
          email: `${randomUUID()}@lifecycle.test`,
          password: `kind-${randomUUID()}`,
          turnstile_token: 'unused',
        });
        if (response.status === 400) return 'denied';
        throw new Error(`Registration with a kind answered HTTP ${response.status}`);
      }
      const reference = await refused(() => wf().beginRegistration({ key: input.key, handle: input.handle }));
      if (reference === 'denied') return 'denied';
      registrations.set(reference.accountId, reference.registrationId);
      return { accountId: reference.accountId, expiresAt: reference.expiresAt };
    },
    async newCredential(kind) {
      if (kind === 'password') {
        const stored: StoredCredential = {
          kind,
          email: `${randomUUID()}@lifecycle.test`,
          password: `lifecycle-${randomBytes(12).toString('hex')}`,
        };
        return { opaque: stored };
      }
      const pair = await generateKeyPair('ES256', { extractable: true });
      const kid = randomUUID();
      const stored: StoredCredential = {
        kind,
        kid,
        publicJwk: { ...(await exportJWK(pair.publicKey)), alg: 'ES256', kid },
        privateKey: pair.privateKey,
      };
      return { opaque: stored };
    },
    async installRegistrationCredential(registration, credential) {
      const stored = credentialOf(credential);
      if (stored.kind !== 'password') throw new Error('Registration installs a password credential');
      const registrationId = required(registrations.get(registration.accountId), 'Unknown registration');
      const result = await refused(() =>
        wf().installRegistrationCredential({ registrationId, email: stored.email, password: stored.password }),
      );
      if (result === 'denied') return 'denied';
      emails.set(registration.accountId, stored.email);
      return 'permitted';
    },
    async activate(registration) {
      const registrationId = required(registrations.get(registration.accountId), 'Unknown registration');
      const result = await refused(() => wf().activateRegistration(registrationId));
      return result === 'denied' ? 'denied' : 'permitted';
    },
    async account(id): Promise<Account> {
      const row = await accountRow(id);
      return {
        id: row.accountId,
        kind: row.kind as Account['kind'],
        handle: row.handle ?? '',
        operatorId: row.operatorAccountId,
        state: row.state as Account['state'],
        minimumAuthnEpoch: Number(row.minimumAuthnEpoch),
        fenced: row.fenced,
      };
    },
    async resolveHandle(handle) {
      const found = await native().internalLifecycle.resolveHandle(handle);
      return found ? { accountId: found.accountId, redirect: found.redirect } : null;
    },
    async authInventory() {
      const identities = await authDb().query<{ id: string }>('SELECT id FROM "user" ORDER BY id');
      const credentials = await authDb().query<{ id: string }>(
        `SELECT "userId" AS id FROM account WHERE password IS NOT NULL
         UNION SELECT account_id FROM auth_public_key ORDER BY 1`,
      );
      return {
        identityAccountIds: identities.rows.map((row) => row.id),
        credentialAccountIds: credentials.rows.map((row) => row.id),
      };
    },
    async signIn(subjectId, credential): Promise<Login> {
      let response: Response;
      const stored = credential ? credentialOf(credential) : undefined;
      if (stored?.kind === 'key') {
        response = await post('/signin/key', {
          account_id: subjectId,
          assertion: await signedAssertion(subjectId, stored),
          client_id: clientId,
          scope: scopes,
        });
      } else if (stored) {
        response = await signInPassword(subjectId, stored.password);
      } else {
        response = await post('/signin', { account_id: subjectId, client_id: clientId, scope: scopes });
      }
      const settled = await settle(response, 'Auth sign-in');
      if (settled === 'denied') return { outcome: 'denied' };
      return remember(subjectId, cookies(settled));
    },
    openSession: openingFor,
    async session(session) {
      const caller = callerOf(session);
      const proof = await readSessionProof(caller);
      const cookie = required(caller.headers.get('cookie'), 'Session has no cookie');
      const token = decodeURIComponent(required(cookie.split(';')[0], 'Malformed cookie').split('=')[1] ?? '').split(
        '.',
      )[0];
      const opening = (
        await authDb().query<{ acting_human_id: string }>(
          'SELECT o.acting_human_id FROM auth_session_opening o JOIN session s ON s.id=o.session_id WHERE s.token=$1',
          [token],
        )
      ).rows[0];
      return {
        subjectId: proof.account_id,
        actingHumanId: opening?.acting_human_id ?? proof.account_id,
        authnEpoch: proof.authn_epoch,
      };
    },
    async issueToken(session): Promise<Token | 'denied'> {
      const token = await bearer(callerOf(session));
      return token === 'denied' ? 'denied' : { opaque: token };
    },
    async validateSession(session): Promise<Outcome> {
      const response = await settle(await get('/session', callerOf(session)), 'Auth session proof');
      return response === 'denied' ? 'denied' : 'permitted';
    },
    async validateToken(token): Promise<Outcome> {
      try {
        await access().authenticate(required(token.opaque as string | undefined, 'Foreign token handle'), boundary());
        return 'permitted';
      } catch (error) {
        if (error instanceof AuthenticationError) return 'denied';
        throw error;
      }
    },
    async createOrganization(owner, handle) {
      const caller = callerOf(owner);
      const ownerId = caller.accountId;
      if (!grantedCreators.has(ownerId)) {
        await governorGrant(PLATFORM_RESOURCE.id, ownerId, ['organization:create']);
        grantedCreators.add(ownerId);
      }
      const key = label('organization');
      const approval = await approved(caller, key, { kind: 'organization', handle });
      const created = await wf().createOrganization({ key, authorization: approval.reference, handle });
      return created.accountId;
    },
    async createAutomated(actingHuman, operatorId, handle) {
      const caller = callerOf(actingHuman);
      const key = label('automated');
      const result = await refused(async () => {
        const approval = await approved(caller, key, {
          kind: 'automated',
          registrationId: '',
          operatorAccountId: operatorId,
          handle,
          operationKey: key,
        });
        return wf().createAutomated({ key, handle, operatorAccountId: operatorId, authorization: approval.reference });
      });
      return result === 'denied' ? 'denied' : result.accountId;
    },
    async patchAccount(actingHuman, id, patch) {
      const caller = callerOf(actingHuman);
      const { handle, ...rest } = patch;
      if (handle !== undefined) {
        const current = await accountRow(id);
        const renamed = await refused(async () => {
          const key = label('rename');
          const normalized = handle.toLowerCase();
          const approval = await approved(caller, key, {
            kind: 'rename',
            accountId: id,
            handle: normalized,
            expectedHandle: current.handle,
          });
          return wf().renameHandle({
            key,
            authorization: approval.reference,
            accountId: id,
            handle,
            expectedHandle: current.handle,
          });
        });
        if (renamed === 'denied') return 'denied';
        if (Object.keys(rest).length === 0) return 'permitted';
      }
      const result = await refused(async () => {
        const ctx = await actorContext(caller);
        return native().lifecycle.updateAccount(ctx, { accountId: id, key: label('update'), patch: rest });
      });
      return result === 'denied' ? 'denied' : 'permitted';
    },
    async acceptOperator(actingHuman, id, operatorId) {
      const caller = callerOf(actingHuman);
      const { previous, expectedVersion } = await transferRecord(caller, id);
      const operationKey = label('transfer');
      const result = await refused(async () => {
        const approval = await approved(caller, operationKey, {
          kind: 'transfer-acceptance',
          previous,
          expectedVersion,
          operatorAccountId: operatorId,
          sourceOperationKey: operationKey,
        });
        return approval.reference;
      });
      if (result === 'denied') return 'denied';
      acceptances.set(`${id}:${operatorId}`, { operationKey, reference: result });
      return 'permitted';
    },
    async setOperator(actingHuman, id, operatorId) {
      const caller = callerOf(actingHuman);
      const { previous, expectedVersion } = await transferRecord(caller, id);
      // The destination's acceptance, when one was given, travels with the transfer it names.
      const accepted = acceptances.get(`${id}:${operatorId}`);
      const key = accepted?.operationKey ?? label('transfer');
      const acceptance = accepted ? { acceptance: accepted.reference } : {};
      const result = await refused(async () => {
        const approval = await approved(caller, key, {
          kind: 'transfer',
          previous,
          expectedVersion,
          operatorAccountId: operatorId,
          ...acceptance,
        });
        return wf().transferOperator({
          key,
          authorization: approval.reference,
          previous,
          expectedVersion,
          operatorAccountId: operatorId,
          ...acceptance,
        });
      });
      if (result === 'denied') return 'denied';
      acceptances.delete(`${id}:${operatorId}`);
      return 'permitted';
    },
    async setManagement(actingHuman, operatorId, humanId, allowed) {
      const caller = callerOf(actingHuman);
      const result = await refused(async () => {
        const ctx = await actorContext(caller);
        const commands = grantsFor('account:manage');
        const grant = {
          resource: { route: route(operatorId), id: operatorId },
          subject: { kind: 'account' as const, id: humanId },
          actions: ['account:manage'],
          valid: OPEN_INTERVAL,
          key: label('management'),
        };
        return allowed ? commands.create(ctx, grant) : commands.revoke(ctx, grant);
      });
      return result === 'denied' ? 'denied' : 'permitted';
    },
    async setMembership(owner, organizationId, accountId, role) {
      const caller = callerOf(owner);
      const result = await refused(async () => {
        const key = label('membership');
        const reservationId = role === null ? await reservationOf(accountId, organizationId) : undefined;
        const operation = {
          kind: 'membership',
          organizationId,
          memberAccountId: accountId,
          role,
          ...(reservationId ? { reservationId } : {}),
        };
        const approval = await approved(caller, key, operation);
        return wf().setMembership({
          key,
          authorization: approval.reference,
          organizationId,
          memberAccountId: accountId,
          role,
          ...(reservationId ? { reservationId } : {}),
        });
      });
      return result === 'denied' ? 'denied' : 'permitted';
    },
    async members(organizationId) {
      const rows = await db().query<{ account_id: string; role: 'owner' | 'member' }>(
        `SELECT member_account_id::text AS account_id,role FROM access.organization_member
         WHERE route=$1 AND organization_id=$2 AND valid @> $3::timestamptz ORDER BY member_account_id`,
        [route(organizationId), organizationId, clock().toISOString()],
      );
      return rows.rows.map((row) => ({ accountId: row.account_id, role: row.role }));
    },
    async setCredential(manager, subjectId, credential, installed) {
      const caller = callerOf(manager);
      const stored = credentialOf(credential);
      const effect =
        stored.kind === 'password'
          ? { kind: 'password', password: installed ? stored.password : null }
          : installed
            ? { kind: 'key', kid: stored.kid, publicJwk: stored.publicJwk }
            : { kind: 'key', kid: stored.kid, remove: true };
      const staged = await settle(
        await post('/credential-effects/stage', { key: label('credential'), subjectId, credential: effect }, caller),
        'credential stage',
      );
      if (staged === 'denied') return 'denied';
      const operation = (await staged.json()) as Record<string, unknown>;
      const approval = await settle(await post('/credential-effects/approve', operation, caller), 'credential approve');
      if (approval === 'denied') return 'denied';
      const { reference } = (await approval.json()) as { reference: string };
      const applied = await settle(
        await post('/credential-effects/apply', { ...operation, reference }, caller),
        'credential apply',
      );
      return applied === 'denied' ? 'denied' : 'permitted';
    },
    async startEmailRecovery(subjectId) {
      const known = emails.get(subjectId);
      const stored = (
        await authDb().query<{ email: string | null }>('SELECT email FROM "user" WHERE id=$1', [subjectId])
      ).rows[0]?.email;
      // An account with no address cannot be named by one; the product sees an address it does not hold.
      const email = known ?? stored ?? `${subjectId}@no-recovery-address.test`;
      const before = recoveries.get(subjectId)?.length ?? 0;
      const response = await post('/recovery/start', { email });
      if (!response.ok) return 'denied';
      const deadline = Date.now() + WAIT_FOR_RECOVERY_DELIVERY_MS;
      while (Date.now() < deadline) {
        const delivered = recoveries.get(subjectId) ?? [];
        if (delivered.length > before) return { opaque: { accountId: subjectId, token: delivered.at(-1)! } };
        await Bun.sleep(10);
      }
      return 'denied';
    },
    async recover(subjectId, proof) {
      const { token } = proof.opaque as { token: string };
      const response = await post('/recovery/complete', {
        account_id: subjectId,
        token,
        new_password: `recovered-${randomBytes(12).toString('hex')}`,
      });
      const settled = await settle(response, 'Auth recovery completion');
      return settled === 'denied' ? 'denied' : 'permitted';
    },
    async populatePrivateData(subjectId) {
      const secretBirthDate = '1990-06-15';
      const marker = `private-${randomUUID()}`;
      // The subject's own session, or its operator opening one: both are real Auth sessions.
      const own = latest.get(subjectId);
      const operatorId = (await responsibilityOf(subjectId))?.operator_account_id;
      const operatorSession = operatorId ? latest.get(operatorId) : undefined;
      let caller = own;
      if (!caller && operatorSession) {
        const opened = await openingFor({ opaque: operatorSession }, subjectId);
        if (opened.outcome === 'authenticated') caller = callerOf(opened.session);
      }
      if (!caller) throw new Error(`No session can reach the private settings of ${subjectId}`);
      const ctx = await actorContext(caller);
      const populated = await refused(() =>
        native().lifecycle.updateAccount(ctx, {
          accountId: subjectId,
          key: label('private-data'),
          patch: { birthDate: secretBirthDate, contentPreferences: { marker } },
        }),
      );
      const addresses = [subjectId, operatorId].flatMap((id) => (id ? [emails.get(id)] : []));
      return {
        populated: populated !== 'denied',
        secretValues: [secretBirthDate, marker, ...addresses.filter((value): value is string => value !== undefined)],
      };
    },
    async profile(subjectId): Promise<PublicView> {
      const value = required(
        await withConnection(db(), (client) => readPublicAccount(client, route(subjectId), subjectId)),
        'No public profile',
      );
      return {
        id: value.accountId,
        kind: value.kind as PublicView['kind'],
        automated: 'operatorAccountId' in value && value.operatorAccountId !== null,
        ...('operatorAccountId' in value && value.operatorAccountId ? { operatorId: value.operatorAccountId } : {}),
        raw: value,
      };
    },
    async attribution(subjectId): Promise<PublicView> {
      const response = await required(kernelHttp, 'Kernel is stopped').handle(
        new Request(`https://kernel.test/v1/accounts?ids=${subjectId}`),
      );
      if (!response.ok) throw new Error(`Public identity read answered HTTP ${response.status}`);
      const body = (await response.json()) as { accounts: Record<string, unknown>[] };
      const value = required(body.accounts[0], 'No public identity');
      return {
        id: value.id as string,
        kind: value.kind as PublicView['kind'],
        automated: value.automated === true,
        ...(value.operatorId ? { operatorId: value.operatorId as string } : {}),
        raw: value,
      };
    },
    async audit(subjectId) {
      const rows = await db().query<{ data: { actingHumanId: string; operatorAccountId: string } }>(
        `SELECT data FROM core.outbox
         WHERE type='com.rezics.access.operator.opening-authorized.v1' AND data->>'subjectAccountId'=$1
         ORDER BY partition_no,position,event_seq`,
        [subjectId],
      );
      return rows.rows.map((row) => ({
        action: 'session-opened' as const,
        actingHumanId: row.data.actingHumanId,
        subjectId,
        operatorId: row.data.operatorAccountId,
      }));
    },
    async createResource(owner) {
      const ownerId = callerOf(owner).accountId;
      // A different route than the owner's, so the resource lives on another partition.
      const resourceId = newId((route(ownerId) + 16) % ROUTES);
      // Fixture fact: the creator's direct grants, as an owning module's initialization would write them.
      await db().query(
        `INSERT INTO access.resource_grant (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
         SELECT $1,$2,$3,'',granted,'(,)'::tstzrange,$4 FROM unnest($5::text[]) AS granted`,
        [route(resourceId), resourceId, ownerId, Bun.randomUUIDv7(), ['access:grant', RESOURCE_ACTION]],
      );
      return resourceId;
    },
    async grantResource(owner, resourceId, accountId) {
      const result = await refused(async () => {
        const ctx = await actorContext(callerOf(owner));
        return grantsFor('access:grant').create(ctx, {
          resource: { route: route(resourceId), id: resourceId },
          subject: { kind: 'account', id: accountId },
          actions: [RESOURCE_ACTION],
          valid: OPEN_INTERVAL,
          key: label('resource-grant'),
        });
      });
      return result === 'denied' ? 'denied' : 'permitted';
    },
    async useResource(session, resourceId) {
      const ctx = await actorContext(callerOf(session));
      const resource = { route: route(resourceId), id: resourceId };
      const evidence = await access().prepare!(ctx.actor, RESOURCE_ACTION, resource, ctx as AccessContext);
      const allowed = await withConnection(db(), (client) =>
        access().authorize(client, ctx.actor, RESOURCE_ACTION, resource, evidence),
      );
      return allowed ? 'permitted' : 'denied';
    },
    async deleteAccount(actingHuman, subjectId) {
      const caller = callerOf(actingHuman);
      const current = await responsibilityOf(subjectId);
      const responsibility = current?.operator_account_id
        ? {
            operatorAccountId: current.operator_account_id,
            subjectAccountId: subjectId,
            reservationId: required(current.operator_reservation_id, 'Operated account has no reservation'),
          }
        : undefined;
      const result = await refused(async () => {
        const key = label('delete');
        const approval = await approved(caller, key, {
          kind: 'delete',
          accountId: subjectId,
          ...(responsibility ? { responsibility } : {}),
        });
        return wf().deleteAccount({
          key,
          authorization: approval.reference,
          accountId: subjectId,
          ...(responsibility ? { responsibility } : {}),
        });
      });
      return result === 'denied' ? 'denied' : 'permitted';
    },
    async suspend(subjectId) {
      const staff = await platform();
      const key = label('suspend');
      const result = await refused(async () => {
        const approval = await approved(staff.caller, key, { kind: 'fence-operator', accountId: subjectId });
        return wf().fenceOperator({ key, authorization: approval.reference, accountId: subjectId });
      });
      if (result === 'denied') return 'denied';
      const continuation = await native().continuations.read(key, subjectId);
      if (continuation) await native().continuations.continueCommitted(continuation.reference);
      return 'permitted';
    },
    async revokeSessions(subjectId, controls) {
      beforeRevocation = controls.beforeAuthRevocation;
      revocationOutage = controls.failAuthRevocation === true;
      delete hook.failure;
      try {
        // Platform governance on the Global Context, the path suspension uses.
        const staff = await platform();
        const key = label('revoke');
        const approval = await approved(staff.caller, key, { kind: 'revoke', accountId: subjectId });
        await wf().revokeSessions({ accountId: subjectId, key, authorization: approval.reference });
        return 'revoked';
      } catch (error) {
        const failed = hookFailure();
        if (failed) throw failed.error;
        if (outage()) return 'revocation-failed';
        throw error;
      } finally {
        beforeRevocation = undefined;
        revocationOutage = false;
      }
    },
    async fenceReceipt(subjectId): Promise<FenceReceipt | null> {
      const row = (
        await db().query<{ receipt_id: string; minimum_authn_epoch: string }>(
          `SELECT receipt_id::text,minimum_authn_epoch::text FROM access.lifecycle_fence_receipt
           WHERE route=$1 AND account_id=$2 ORDER BY minimum_authn_epoch DESC LIMIT 1`,
          [route(subjectId), subjectId],
        )
      ).rows[0];
      return row
        ? { id: row.receipt_id, accountId: subjectId, minimumAuthnEpoch: Number(row.minimum_authn_epoch) }
        : null;
    },
  };
  return driver;
}

let latest: Promise<AccountLifecycleDriver> | undefined;
/** A namespace whose hook timed out is never closed by its caller; release it before the next one starts. */
export async function createAccountLifecycleDriver(): Promise<AccountLifecycleDriver> {
  await latest?.then(
    (previous) => previous.close(),
    () => {},
  );
  const created = openDriver();
  latest = created;
  return created;
}
