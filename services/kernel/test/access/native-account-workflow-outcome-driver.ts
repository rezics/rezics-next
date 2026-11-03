import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { DBOS, DBOSClient, type FunctionName, type StepConfig } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import type { Actor, AccessContext, Resource } from '../../src/request/access.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { COMMITTED_CONTINUATION_ACTIONS, type ContinuationEntry } from '../../src/access/committed-continuations.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { WORKFLOW_APPROVAL_ACTIONS } from '../../src/access/workflow-approvals.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import platformGovernance from '../../src/access/platform-governance.json';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { seal, unseal } from '../../src/tokens/seal.ts';
import { registerOperatorFenceWork } from '../../src/access/operator-fence-work.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkClient } from '../../src/work/client.ts';
import type { Effect } from '../../src/events/effects.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import type {
  Family,
  Fixture,
  Identity,
  NativeAccountWorkflowDriver,
  Operation,
  ProtectedStep,
  Step,
  Snapshot,
  Work,
} from '../../../../specs/native-account-workflow-driver.ts';

const password = 'native-account-workflow-test-password';
const hookContext = new AsyncResource('native-account-workflow-driver');
const requestedScopes = [
  ...platformGovernance.actions,
  ...LIFECYCLE_ACTIONS.keys(),
  ...COMMITTED_CONTINUATION_ACTIONS.keys(),
  ...WORKFLOW_APPROVAL_ACTIONS.keys(),
  'account:manage',
  'account:read',
  'account:update',
  'account:delete',
  'account:suspend',
  'account:renew_cleanup',
  'access:grant',
  'access:delegate',
  'organization:create',
  'organization:membership',
  'client:manage',
];
const scopes = [...new Set(requestedScopes)].sort();
const source = new URL(process.env.DATABASE_URL ?? '');
if (!source.protocol) throw new Error('DATABASE_URL must name the isolated migrated kernel database');
const suffix = randomUUID().replaceAll('-', '');
let authDatabase = '';
let kernelDatabase = '';
const databaseUrl = (database: string) => {
  const url = new URL(source.href);
  url.pathname = `/${database}`;
  return url.href;
};
let authUrl = '';
const issuer = `https://native-workflow-${suffix}.auth.test`;
const audience = 'https://native-workflow.api.test';
const loginClient = `native-login-${suffix}`;
let appClient = `native-app-${suffix}`;
const otherClient = `native-other-${suffix}`;
const routeKey = randomBytes(32);
const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const stagingKey = randomBytes(32);
const hostSecret = randomBytes(48).toString('base64url');
const actions = new Map([...LIFECYCLE_ACTIONS, ...COMMITTED_CONTINUATION_ACTIONS, ...actionDeclarations(scopes)]);
let admin = undefined as unknown as Pool;
let kernel = undefined as unknown as ReturnType<typeof createPool>;
let facts = undefined as unknown as Pool;
let proofsPool: Pool | undefined;
let authPool: Pool | undefined;
let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
let service: AuthService | undefined;
let bindings: ReturnType<typeof createNativeAccountBindings> | undefined;
let accessPort: ReturnType<typeof createAccess> | undefined;
let approvalPort:
  | ReturnType<typeof import('../../src/access/workflow-approvals.ts').createWorkflowApprovals>
  | undefined;
let fenceClient: WorkClient | undefined;
let fenceEffects: Effect[] = [];
let releaseBackgroundPages: (() => void) | undefined;
let backgroundPages = Promise.resolve();
let governor: Awaited<ReturnType<typeof person>> | undefined;
let clientsRegistered = false;
const owned = new Set<Fixture>();
const operationFixtures = new Map<string, Fixture>();
const staleCallerTokens = new WeakMap<Fixture, string>();
const registrations = new Map<
  string,
  { accountId: string; email: string; handle: string; session: Headers; otherSession?: Headers }
>();
const observedStepNames = new Map<Family, { fixture: Fixture; steps: ProtectedStep[] }>();
type StepObserver = (name: string, args: unknown[]) => Promise<void>;
type PendingWorkflow = { release(): void; promise: Promise<unknown> };
let stepObserver: StepObserver | undefined;
let afterStep: StepObserver | undefined;
let activeStepName: string | undefined;
let activeStepTarget: string | undefined;
let activeHook: { before: Step; boundary?: 'step' | 'attempt-T'; run(): Promise<void>; used: boolean } | undefined;
let restoreEvidenceReader: (() => void) | undefined;
let evidenceUnavailable = false;
const pendingWorkflows = new Map<string, PendingWorkflow>();
const completedCrashSteps = new Set<string>();
const continuedOperations = new Set<string>();
const originalRegisterStep = DBOS.registerStep.bind(DBOS);
DBOS.registerStep = (<This, Args extends unknown[], Return>(
  func: (this: This, ...args: Args) => Promise<Return>,
  config?: StepConfig & FunctionName,
) => {
  const wrapped = async function (this: This, ...args: Args) {
    const name = config?.name ?? '';
    const phase = name.startsWith('accounts.') ? name.slice('accounts.'.length) : name;
    const logicalName = phase === 'operator-fence-page.run' ? 'operator-responsibility-page' : phase;
    if (phase === 'operator-fence-page.run') await backgroundPages;
    const previous = activeStepName;
    activeStepName = logicalName;
    try {
      await stepObserver?.(logicalName, args);
      const result = await func.apply(this, args);
      await afterStep?.(logicalName, args);
      return result;
    } finally {
      activeStepName = previous;
    }
  };
  return originalRegisterStep<This, Args, Return>(wrapped, config);
}) as typeof DBOS.registerStep;
const deniedError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error && (error.status === 401 || error.status === 403);
const refused = async <T>(work: () => Promise<T>): Promise<T | { outcome: 'denied' }> => {
  try {
    return await work();
  } catch (error) {
    if (
      deniedError(error) ||
      (evidenceUnavailable && typeof error === 'object' && error !== null && 'status' in error && error.status === 503)
    )
      return { outcome: 'denied' };
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : 'unclassified';
    throw new Error(`Native workflow boundary returned unclassified status ${String(status)}`);
  }
};
const required = <T>(value: T | null | undefined, message: string): T => {
  if (value == null) throw new Error(message);
  return value;
};
const tokenCookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; '),
  });
const workflows = () => required(host, 'Auth host is stopped').workflows;
const auth = () => required(service, 'Auth service is stopped');
const native = () => required(bindings, 'Native account bindings are unavailable');
const approvals = () => required(approvalPort, 'Native workflow approvals are unavailable');
const context = () => ({ pool: required(kernel, 'Kernel pool is unavailable'), deadline: Date.now() + 20_000 });
const reference = (prefix: string) => `${prefix}-${randomUUID()}`;
const handle = (prefix: string) =>
  `${prefix.replaceAll(/[^a-z0-9_-]/gi, '_').toLowerCase()}_${randomUUID().slice(0, 8)}`;

async function request(path: string, body: unknown, session?: Headers): Promise<Response> {
  return required(host, 'Auth host is stopped').handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: {
        origin: issuer,
        'content-type': 'application/json',
        cookie: session?.get('cookie') ?? '',
      },
      body: JSON.stringify(body),
    }),
  );
}

async function login(
  email: string,
  clientId: string,
  requested = scopes,
): Promise<{ session: Headers; bearer: string }> {
  const signed = await request('/signin', { email, password, client_id: clientId, scope: requested });
  if (!signed.ok)
    throw Object.assign(new Error(`Auth signin failed: ${signed.status} ${await signed.text()}`), {
      status: signed.status,
    });
  const session = tokenCookies(signed);
  const token = await request('/token', {}, session);
  if (!token.ok)
    throw Object.assign(new Error(`Auth token failed: ${token.status} ${await token.text()}`), {
      status: token.status,
    });
  const body = (await token.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string') throw new Error('Auth did not issue an access token');
  return { session, bearer: body.access_token };
}

async function tokenFor(accountId: string, requestedBy: string, clientId = appClient) {
  const identity = registrations.get(accountId);
  if (!identity) throw new Error(`Missing native login session for ${accountId}`);
  const session = await login(identity.email, clientId);
  const response = await request('/token', { requested_by: requestedBy }, session.session);
  if (!response.ok) throw new Error(`Delegated Auth token failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string') throw new Error('Auth did not issue a delegated access token');
  return { bearer: body.access_token, session: session.session };
}

async function consentSession(accountId: string): Promise<Headers> {
  const account = await facts.query<{ operator_account_id: string | null }>(
    'SELECT operator_account_id::text FROM access.account WHERE route=$1 AND account_id=$2',
    [route(accountId), accountId],
  );
  const operatorAccountId = required(account.rows[0], 'Missing consent account').operator_account_id;
  const identity = required(registrations.get(operatorAccountId ?? accountId), 'Missing consent session identity');
  const current = await login(identity.email, loginClient);
  if (!operatorAccountId) return current.session;
  const key = reference('consent-operator-session');
  const operation = { kind: 'opening' as const, operatorAccountId, subjectAccountId: accountId };
  const approval = await approvalFor(current.bearer, { operationKey: key, operation });
  const response = await workflows().openOperatorSession({
    key,
    authorization: approval.reference,
    operatorAccountId,
    subjectAccountId: accountId,
    headers: current.session,
  });
  if (!response.ok) throw new Error(`Native consent session opening failed: ${response.status}`);
  return tokenCookies(response);
}

async function person(prefix: string, firstPartyOnly = false) {
  const id = randomUUID().replaceAll('-', '');
  const email = `${id}@native-workflow.test`;
  const handleValue = handle(prefix);
  const account = await workflows().register({
    key: reference(`registration-${prefix}`),
    handle: handleValue,
    email,
    password,
  });
  const loginSession = await login(email, loginClient);
  for (const clientId of firstPartyOnly ? [] : [appClient, otherClient]) {
    const consent = await request('/consent', { client_id: clientId, scope: scopes }, loginSession.session);
    if (!consent.ok) throw new Error(`Auth consent failed: ${consent.status} ${await consent.text()}`);
  }
  const main = firstPartyOnly ? loginSession : await login(email, appClient);
  const alternate = firstPartyOnly ? loginSession : await login(email, otherClient);
  const record = { accountId: account.accountId, email, handle: handleValue, session: main.session };
  registrations.set(record.accountId, { ...record, otherSession: alternate.session });
  return { ...record, bearer: main.bearer, otherBearer: alternate.bearer, otherSession: alternate.session };
}

async function buildHost() {
  authPool = new Pool({ connectionString: authUrl });
  proofsPool ??= new Pool({ connectionString: authUrl });
  if (!bindings) {
    const proofs = createNativeWorkflowProofPorts({ database: proofsPool });
    accessPort = createAccess({
      actions,
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => auth().handler(new Request(`${issuer}/.well-known/jwks.json`)),
      },
    });
    if (accessPort.prepare) {
      const prepare = accessPort.prepare.bind(accessPort);
      const wrappedPrepare = async (
        actor: Actor,
        action: string,
        resource: Resource,
        commandContext: AccessContext,
      ) => {
        const evidence = await prepare(actor, action, resource, commandContext);
        const hook = activeHook;
        if (
          hook &&
          !hook.used &&
          hook.boundary === 'attempt-T' &&
          activeStepName === hook.before.name &&
          activeStepTarget === hook.before.target
        ) {
          hook.used = true;
          activeHook = undefined;
          await hookContext.runInAsyncScope(() => hook.run());
        }
        if (evidenceUnavailable)
          throw Object.assign(new Error('Native authority evidence unavailable'), { status: 503 });
        return evidence;
      };
      accessPort.prepare = wrappedPrepare;
    }
    bindings = createNativeAccountBindings({
      pool: kernel,
      access: accessPort,
      actions,
      routeKey,
      referenceKeys,
      auth: () => auth(),
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: proofsPool }),
        barriers: createBarrierProofVerifier({ database: proofsPool }),
      },
    });
    const authorizeOpening = bindings.workflowPorts.authorizeOpening;
    if (authorizeOpening)
      bindings.workflowPorts.authorizeOpening = async (...args) => {
        const previous = activeStepName;
        activeStepName = 'authorize-opening';
        try {
          await stepObserver?.('authorize-opening', args);
          const value = await authorizeOpening(...args);
          await afterStep?.('authorize-opening', args);
          return value;
        } finally {
          activeStepName = previous;
        }
      };
    approvalPort = (await import('../../src/access/workflow-approvals.ts')).createWorkflowApprovals({
      pool: kernel,
      access: accessPort,
      actions,
      referenceKeys,
      creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
    });
  }
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: hostSecret,
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    siteActions: actions,
    trustedAccess: native().trustedAccess,
    access: native().workflowPorts,
    stagingKey,
    maintenanceSchedule: '0 0 1 1 *',
    executorId: `native-workflow-${suffix}`,
  });
  service = host.service;
  const client = await DBOSClient.create({
    systemDatabaseUrl: authUrl,
    systemDatabaseSchemaName: 'auth_dbos',
    applicationName: 'rezics-auth-accounts',
    systemDatabasePool: proofsPool,
  });
  fenceClient = Object.assign(client, {
    close: () => client.destroy(),
    async discoverLegacyLeaveChild(_workflowId: string): Promise<string | null> {
      throw new Error('Fence fixture does not discover legacy leave children');
    },
  });
  fenceEffects = [];
  backgroundPages = new Promise<void>((resolve) => {
    releaseBackgroundPages = resolve;
  });
  registerOperatorFenceWork(
    {
      pool: kernel,
      queues: WORK_QUEUES,
      client: fenceClient,
      getAuthorization() {
        throw new Error('Fence fixture does not consume worker authorization');
      },
      env: process.env,
      clock: () => new Date(),
      addEffects: (effects) => {
        fenceEffects.push(...effects);
      },
      addService: () => {
        throw new Error('Unexpected fence background service');
      },
    },
    referenceKeys,
  );
  await host.start();
  await DBOS.registerQueue('workflows', WORK_QUEUES.workflows);
  if (!clientsRegistered) {
    await auth().internal.registerClient({ clientId: loginClient, firstParty: true, scopes });
    await auth().internal.registerClient({ clientId: appClient, firstParty: false, scopes });
    await auth().internal.registerClient({ clientId: otherClient, firstParty: false, scopes });
    clientsRegistered = true;
  }
}

const pair = await generateKeyPair('ES256', { extractable: true });
const signingKey: JWK & { kid: string } = { ...(await exportJWK(pair.privateKey)), kid: `native-${suffix}` };

async function approvalFor(caller: string, work: Work) {
  const op = { ...work.operation, authorization: 'native-approval-request' };
  const result = await approvals().approve(caller, { operationKey: work.operationKey, operation: op }, context());
  return result;
}

function accountOperation(work: Work) {
  return { ...work.operation, operationKey: work.operationKey, authorization: 'native-approval-request' };
}

function observedReceiptId(row: { transaction_id: string; response: unknown }): string {
  return row.response &&
    typeof row.response === 'object' &&
    'receiptId' in row.response &&
    typeof row.response.receiptId === 'string'
    ? row.response.receiptId
    : row.transaction_id;
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new Error(`Invalid native account id: ${id}`);
  return value;
}

async function continuationAllowlist(f: Fixture, fallback: ContinuationEntry[]): Promise<ContinuationEntry[]> {
  const root = await facts.query<{
    continuation_id: string;
    allowlist: ContinuationEntry[];
  }>('SELECT continuation_id::text, allowlist FROM access.committed_continuation WHERE route=$1 AND operation_key=$2', [
    route(continuationAccount(f)),
    f.work.operationKey,
  ]);
  const row = root.rows[0];
  if (!row) return fallback;
  const pages = await facts.query<{ allowlist: ContinuationEntry[] }>(
    `WITH RECURSIVE pages AS (
       SELECT page.page_key, page.cursor, page.next_cursor, page.allowlist, 0 AS commit_order
       FROM access.operator_fence_page AS page
       WHERE page.route=$1 AND page.continuation_id=$2 AND page.cursor IS NULL
       UNION ALL
       SELECT child.page_key, child.cursor, child.next_cursor, child.allowlist, pages.commit_order+1
       FROM pages
       JOIN access.operator_fence_page AS child
         ON child.route=$1 AND child.continuation_id=$2 AND child.cursor=pages.next_cursor
       WHERE pages.next_cursor IS NOT NULL
     )
     SELECT allowlist FROM pages ORDER BY commit_order`,
    [route(continuationAccount(f)), row.continuation_id],
  );
  return [...row.allowlist, ...pages.rows.flatMap((page) => page.allowlist)];
}

function crashStepKey(f: Fixture, step: string, target: string): string {
  return `${f.work.operationKey}\0${step}\0${target}`;
}

function continuationAccount(f: Fixture): string {
  return f.work.operation.kind === 'delete' ? f.work.operation.accountId : f.ownerId;
}

async function connect() {
  authDatabase = `native_workflow_${randomUUID().replaceAll('-', '')}`;
  kernelDatabase = `native_kernel_${randomUUID().replaceAll('-', '')}`;
  authUrl = databaseUrl(authDatabase);
  admin = new Pool({ connectionString: databaseUrl('postgres') });
  const template = source.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(template)) throw new Error('Invalid migrated kernel database name');
  await admin.query(`CREATE DATABASE "${kernelDatabase}" TEMPLATE "${template}"`);
  kernel = createPool(databaseUrl(kernelDatabase));
  facts = new Pool({ connectionString: databaseUrl(kernelDatabase) });
  proofsPool = undefined;
  authPool = undefined;
  host = undefined;
  service = undefined;
  bindings = undefined;
  accessPort = undefined;
  approvalPort = undefined;
  owned.clear();
  operationFixtures.clear();
  registrations.clear();
  observedStepNames.clear();
  completedCrashSteps.clear();
  clientsRegistered = false;
  governor = undefined;
  await admin.query(`CREATE DATABASE "${authDatabase}"`);
  migrateAuth(authUrl, fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
  await buildHost();
  if (!governor) {
    governor = await person('platform-staff', true);
    registrations.set(governor.accountId, { ...governor, session: governor.session });
    await bootstrapGovernance(kernel, governor.accountId);
    const actor = await accessPort!.authenticate(governor.bearer, context());
    const standing = await facts.query<{ valid: string }>(
      `SELECT valid::text FROM access.resource_grant WHERE resource_id=$1
       AND subject_kind='active_accounts' AND action='organization:create'`,
      [PLATFORM_RESOURCE.id],
    );
    for (const row of standing.rows)
      await createGrantCommands({ pool: kernel, access: accessPort!, managementAction: 'access:grant' }).revoke(
        { ...context(), actor },
        {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'active_accounts' },
          actions: ['organization:create'],
          valid: row.valid,
          key: reference('remove-standing-organization-grant'),
        },
      );
  }
  return governor;
}

function identityOf(
  personValue: Awaited<ReturnType<typeof person>>,
  requestedBy: string | null = null,
  epoch = '1',
): Identity {
  return {
    actorId: personValue.accountId,
    clientId: appClient,
    scopes: [...scopes],
    requestedBy,
    epoch,
  };
}

async function grantActions(resourceId: string, subjectId: string, acts: string[], issuerBearer: string, key: string) {
  const actor = await required(accessPort, 'Access is not composed').authenticate(issuerBearer, context());
  const command = createGrantCommands({
    pool: kernel,
    access: required(accessPort, 'Access is not composed'),
    managementAction:
      actor.accountId === required(governor, 'Platform governance is not bootstrapped').accountId
        ? 'access:grant'
        : 'account:manage',
  });
  await command.create(
    { ...context(), actor },
    {
      resource: { route: route(resourceId), id: resourceId },
      subject: { kind: 'account', id: subjectId },
      actions: acts,
      valid: '(,)',
      key,
    },
  );
}

async function createOrganization(owner: Awaited<ReturnType<typeof person>>, prefix: string) {
  const handleValue = handle(prefix);
  const operationKey = reference(`organization-${prefix}`);
  await grantActions(
    PLATFORM_RESOURCE.id,
    owner.accountId,
    ['organization:create'],
    required(governor, 'Platform governance is not bootstrapped').bearer,
    reference('organization-creator-grant'),
  );
  const operation = { kind: 'organization' as const, authorization: 'native-approval-request', handle: handleValue };
  const approval = await approvals().approve(owner.bearer, { operationKey, operation }, context());
  const result = await workflows().createOrganization({
    key: operationKey,
    authorization: approval.reference,
    handle: handleValue,
  });
  return { accountId: result.accountId, handle: handleValue };
}

async function addOrganizationOwner(
  organizationId: string,
  owner: Awaited<ReturnType<typeof person>>,
  member: Awaited<ReturnType<typeof person>>,
) {
  const reservation = await native().workflowPorts.reserveCoordination!({
    accountId: member.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: reference('membership-owner-reservation'),
  });
  const actor = await required(accessPort, 'Access is not composed').authenticate(owner.bearer, context());
  await native().workflowPorts.setMembership!(
    { ...context(), actor },
    {
      organizationId,
      memberAccountId: member.accountId,
      reservationId: reservation.value.reservationId,
      role: 'owner',
      key: reference('membership-owner-create'),
    },
  );
}

async function selfDelegate(personValue: Awaited<ReturnType<typeof person>>) {
  return delegate(personValue, personValue);
}

async function delegate(principal: Awaited<ReturnType<typeof person>>, assignee: Awaited<ReturnType<typeof person>>) {
  const actor = await required(accessPort, 'Access is not composed').authenticate(principal.bearer, context());
  const command = createDelegationCommands({
    pool: kernel,
    access: required(accessPort, 'Access is not composed'),
    action: 'account:manage',
  });
  const requestId = newId(route(principal.accountId));
  const assignment = await command.create(
    { ...context(), actor },
    {
      principalId: principal.accountId,
      assignedActorId: assignee.accountId,
      requestId,
      valid: '(,)',
      key: reference('assignment'),
    },
  );
  const delegated = await tokenFor(assignee.accountId, assignment.value.requestedBy);
  return { requestedBy: assignment.value.requestedBy, requestId, ...delegated };
}

async function createOperatorLink(operatorAccountId: string, subjectAccountId: string) {
  const reserved = await native().operators.reserveResponsibility({
    operatorAccountId,
    subjectAccountId,
    key: reference('responsibility-reserve'),
  });
  const current = await facts.query<{
    operator_account_id: string | null;
    operator_relation_version: string;
  }>(
    'SELECT operator_account_id::text,operator_relation_version::text FROM access.account WHERE route=$1 AND account_id=$2',
    [route(subjectAccountId), subjectAccountId],
  );
  const account = required(current.rows[0], 'Native responsibility subject is missing');
  await native().operators.recordOperatorRelation({
    ...reserved.value,
    expectedOperatorAccountId: account.operator_account_id,
    expectedVersion: account.operator_relation_version,
    key: reference('responsibility-record'),
  });
  return reserved.value;
}

async function automatedFor(operatorAccountId: string, actor: Awaited<ReturnType<typeof person>>, prefix: string) {
  const key = reference(`automated-${prefix}`);
  const operation = {
    kind: 'automated' as const,
    registrationId: '',
    operatorAccountId: operatorAccountId,
    handle: handle(prefix),
    operationKey: key,
    authorization: 'native-approval-request',
  };
  const approval = await approvals().approve(actor.bearer, { operationKey: key, operation }, context());
  return workflows().createAutomated({
    key,
    handle: operation.handle,
    operatorAccountId,
    authorization: approval.reference,
  });
}

async function automated(operator: Awaited<ReturnType<typeof person>>, prefix: string) {
  return automatedFor(operator.accountId, operator, prefix);
}

function workOperation(
  family: Family,
  ownerId: string,
  subjectId: string,
  nextId: string,
  key: string,
  handleValue: string,
  relation?: { operatorAccountId: string; subjectAccountId: string; reservationId: string },
  organizationOperator = false,
): Operation {
  if (family === 'organization') return { kind: 'organization', handle: handleValue };
  if (family === 'transfer') {
    if (!relation) throw new Error('A transfer requires a current native responsibility');
    return { kind: 'transfer', previous: relation, expectedVersion: '0', operatorAccountId: nextId };
  }
  if (family === 'subject-delete' || family === 'operator-delete')
    return {
      kind: 'delete',
      accountId: family === 'subject-delete' ? subjectId : ownerId,
      ...(family === 'subject-delete' && relation ? { responsibility: relation } : {}),
    };
  if (family === 'fence-operator') return { kind: 'fence-operator', accountId: ownerId };
  return { kind: 'opening', operatorAccountId: organizationOperator ? nextId : ownerId, subjectAccountId: subjectId };
}

async function makeFixture(
  family: Family,
  options: {
    subjects?: number;
    organizationOperator?: boolean;
    independentCredentials?: boolean;
    heldResponsibilities?: boolean;
  } = {},
): Promise<Fixture> {
  const staff = required(governor, 'Platform governance is not bootstrapped');
  appClient = `native-app-${randomUUID()}`;
  await auth().internal.registerClient({ clientId: appClient, firstParty: false, scopes });
  Object.assign(staff, await login(staff.email, loginClient));
  const [owner, nextOperator, subjectPerson, otherSubjectPerson] = await Promise.all([
    person(`${family}-owner`),
    person(`${family}-destination`),
    person(`${family}-subject`),
    person(`${family}-other-subject`),
  ]);
  const callerPerson =
    family === 'organization' || family === 'opening'
      ? owner
      : family === 'fence-operator'
        ? await person('fence-caller')
        : await person(`${family}-caller`);
  const operatorManager =
    family === 'operator-delete' || family === 'subject-delete' ? await person(`${family}-manager`) : undefined;
  let staleCaller: string | undefined;
  if (family === 'opening') {
    staleCaller = callerPerson.bearer;
    const reduced = await request(
      '/consent',
      { client_id: otherClient, scope: scopes.filter((scope) => scope !== 'client:manage') },
      callerPerson.session,
    );
    if (!reduced.ok) throw new Error(`Auth epoch setup failed: ${reduced.status} ${await reduced.text()}`);
    const current = await login(callerPerson.email, appClient);
    const other = await login(
      callerPerson.email,
      otherClient,
      scopes.filter((scope) => scope !== 'client:manage'),
    );
    callerPerson.bearer = current.bearer;
    callerPerson.session = current.session;
    callerPerson.otherBearer = other.bearer;
    callerPerson.otherSession = other.session;
    registrations.set(callerPerson.accountId, {
      ...callerPerson,
      session: current.session,
      otherSession: other.session,
    });
  }
  // Auth session openings consume a personal human session proof without an
  // assignment. The other workflow families exercise delegated human authority.
  const principalAssignment =
    family === 'opening'
      ? null
      : family === 'operator-delete' || family === 'subject-delete'
        ? await delegate(required(operatorManager, 'Operator manager fixture is missing'), callerPerson)
        : await selfDelegate(callerPerson);
  const requestedBy = principalAssignment?.requestedBy ?? null;
  const caller = principalAssignment?.bearer ?? callerPerson.bearer;
  const otherClientCaller = callerPerson.otherBearer;
  const authenticatedCaller = await required(accessPort, 'Access is not composed').authenticate(caller, context());
  const identity = identityOf(callerPerson, requestedBy, String(authenticatedCaller.authnEpoch));
  const operationKey = reference(`operation-${family}`);
  const handleValue = handle(family);
  let organizationId = newId(0);
  let operatorId = owner.accountId;
  let relation: { operatorAccountId: string; subjectAccountId: string; reservationId: string } | undefined;

  if (family === 'organization') {
    await grantActions(
      PLATFORM_RESOURCE.id,
      owner.accountId,
      ['organization:create'],
      staff.bearer,
      reference('organization-creator-grant'),
    );
    const operation = { kind: 'organization' as const, authorization: 'native-approval-request', handle: handleValue };
    const approval = await approvalFor(caller, { operationKey, operation });
    const resolved = await approvals().resolveForCaller(
      caller,
      approval.reference,
      { ...operation, operationKey },
      context(),
    );
    const organizationKey = native().workflowPorts.stableCommandKey!(resolved, 'organization-id');
    organizationId = native().workflowPorts.registrationTarget(organizationKey);
  }
  if (family === 'transfer') {
    await grantActions(
      owner.accountId,
      callerPerson!.accountId,
      ['account:manage'],
      owner.bearer,
      reference('source-manager-grant'),
    );
    await grantActions(
      nextOperator.accountId,
      callerPerson!.accountId,
      ['account:manage'],
      nextOperator.bearer,
      reference('destination-manager-grant'),
    );
    relation = await createOperatorLink(owner.accountId, subjectPerson.accountId);
  }
  if (family === 'subject-delete') {
    relation = await createOperatorLink(owner.accountId, subjectPerson.accountId);
    const manager = required(operatorManager, 'Subject deletion manager fixture is missing');
    for (const grantee of [manager, callerPerson]) {
      await grantActions(
        owner.accountId,
        grantee.accountId,
        ['account:delete', 'account:manage'],
        owner.bearer,
        reference('subject-manager-grant'),
      );
    }
  }
  if (family === 'operator-delete') {
    const manager = required(operatorManager, 'Operator manager fixture is missing');
    for (const grantee of [manager, callerPerson]) {
      await grantActions(
        owner.accountId,
        grantee.accountId,
        ['account:delete', 'account:manage'],
        owner.bearer,
        reference('operator-manager-grant'),
      );
    }
    const count = options.heldResponsibilities ? Math.max(1, options.subjects ?? 1) : 0;
    for (let i = 0; i < count; i++) {
      const child = await person(`delete-child-${i}`);
      await grantActions(
        child.accountId,
        owner.accountId,
        ['account:delete'],
        child.bearer,
        reference('child-deleter'),
      );
      await createOperatorLink(owner.accountId, child.accountId);
    }
  }
  if (family === 'fence-operator') {
    const actor = await accessPort!.authenticate(staff.bearer, context());
    await createGrantCommands({ pool: kernel, access: accessPort!, managementAction: 'access:grant' }).createRole(
      { ...context(), actor },
      {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: callerPerson.accountId },
        role: platformGovernance.role,
        valid: '(,)',
        key: reference('operator-fencer'),
      },
    );
    const count = Math.max(1, options.subjects ?? 1);
    for (let start = 0; start < count; start += 16) {
      const end = Math.min(start + 16, count);
      await Promise.all(
        Array.from({ length: end - start }, async (_, offset) => {
          const i = start + offset;
          const child =
            options.independentCredentials && i === 0 ? subjectPerson : await automated(owner, `fence-child-${i}`);
          if (options.independentCredentials && i === 0) await createOperatorLink(owner.accountId, child.accountId);
        }),
      );
    }
  }
  if (family === 'opening') {
    if (options.organizationOperator) {
      const organization = await createOrganization(owner, 'opening-organization');
      organizationId = organization.accountId;
      operatorId = organization.accountId;
      const backup = await person('opening-backup-owner');
      await addOrganizationOwner(operatorId, owner, backup);
      await addOrganizationOwner(operatorId, owner, callerPerson);
    }
    await grantActions(
      nextOperator.accountId,
      callerPerson.accountId,
      ['account:manage'],
      nextOperator.bearer,
      reference('opening-relation-mismatch-manager'),
    );
    if (operatorId !== callerPerson.accountId)
      await grantActions(
        operatorId,
        callerPerson.accountId,
        ['account:manage'],
        callerPerson.bearer,
        reference('opening-manager'),
      );
    const automatedSubject = await automatedFor(operatorId, callerPerson, 'opening-subject');
    relation = {
      operatorAccountId: operatorId,
      subjectAccountId: automatedSubject.accountId,
      reservationId: required(
        (
          await facts.query<{ operator_reservation_id: string }>(
            'SELECT operator_reservation_id::text FROM access.account WHERE route=$1 AND account_id=$2',
            [route(automatedSubject.accountId), automatedSubject.accountId],
          )
        ).rows[0],
        'Automated opening subject has no native responsibility',
      ).operator_reservation_id,
    };
  }
  const operationSubjectId = family === 'opening' ? relation!.subjectAccountId : subjectPerson.accountId;
  const operation = workOperation(
    family,
    family === 'fence-operator' ? owner.accountId : owner.accountId,
    operationSubjectId,
    family === 'opening' ? operatorId : nextOperator.accountId,
    operationKey,
    handleValue,
    relation,
    options.organizationOperator,
  );
  if (family === 'transfer' && operation.kind === 'transfer') {
    const current = await facts.query<{ operator_relation_version: string }>(
      'SELECT operator_relation_version::text FROM access.account WHERE route=$1 AND account_id=$2',
      [route(subjectPerson.accountId), subjectPerson.accountId],
    );
    operation.expectedVersion = required(
      current.rows[0],
      'Native transfer subject is missing',
    ).operator_relation_version;
  }
  const fixture: Fixture = {
    family,
    work: { operationKey, operation },
    caller,
    otherClientCaller,
    identity,
    ownerId: family === 'opening' ? operatorId : owner.accountId,
    nextOperatorId: nextOperator.accountId,
    subjectId: operationSubjectId,
    otherSubjectId: otherSubjectPerson.accountId,
    organizationId,
    handle: handleValue,
    managementAction: 'account:manage',
  };
  owned.add(fixture);
  if (staleCaller) staleCallerTokens.set(fixture, staleCaller);
  operationFixtures.set(operationKey, fixture);
  return fixture;
}

function bindOperationFixture(caller: string, work: Work): Fixture | undefined {
  const current = operationFixtures.get(work.operationKey);
  if (current) return current;
  const base = [...owned].find(
    (fixture) => fixture.caller === caller && work.operationKey.startsWith(`${fixture.work.operationKey}:`),
  );
  if (!base) return undefined;
  const family = work.operation.kind === 'delete' && work.operation.responsibility ? 'subject-delete' : base.family;
  const fixture: Fixture = {
    ...base,
    family,
    work,
    ...(work.operation.kind === 'delete' ? { subjectId: work.operation.accountId } : {}),
  };
  owned.add(fixture);
  operationFixtures.set(work.operationKey, fixture);
  return fixture;
}

async function executeWorkflow(authReference: string, work: Work): Promise<unknown> {
  const request = { key: work.operationKey, authorization: authReference };
  switch (work.operation.kind) {
    case 'organization':
      return workflows().createOrganization({ ...request, handle: work.operation.handle });
    case 'transfer':
      return workflows().transferOperator({
        ...request,
        previous: work.operation.previous,
        expectedVersion: work.operation.expectedVersion,
        operatorAccountId: work.operation.operatorAccountId,
      });
    case 'delete':
      return workflows().deleteAccount({
        ...request,
        accountId: work.operation.accountId,
        ...(work.operation.responsibility ? { responsibility: work.operation.responsibility } : {}),
      });
    case 'fence-operator':
      return workflows().fenceOperator({ ...request, accountId: work.operation.accountId });
    case 'opening':
      return workflows().authorizeOperatorOpening({
        ...request,
        operatorAccountId: work.operation.operatorAccountId,
        subjectAccountId: work.operation.subjectAccountId,
      });
  }
}

export async function createNativeAccountWorkflowDriver(): Promise<NativeAccountWorkflowDriver> {
  await connect();
  let closed = false;
  const continuationOwners = new Map<string, Fixture>();
  const stepsCache = new WeakMap<Fixture, ProtectedStep[]>();
  const startedDeleteOperations = new Set<string>();
  const driver: NativeAccountWorkflowDriver = {
    fixture: makeFixture,
    async approve(caller, work) {
      bindOperationFixture(caller, work);
      const result = await refused(async () => approvalFor(caller, work));
      if ('outcome' in result) return result;
      return { outcome: 'approved', reference: result.reference, expiresAt: result.expiresAt };
    },
    async approval(referenceValue) {
      const { unseal } = await import('../../src/tokens/seal.ts');
      const { APPROVAL_REFERENCE_PURPOSE } = await import('../../src/access/approved-identity.ts');
      const locator = unseal(referenceKeys, APPROVAL_REFERENCE_PURPOSE, referenceValue) as
        | { route?: number; id?: string }
        | undefined;
      if (!locator?.id || locator.route === undefined) return null;
      const row = await facts.query<{
        actor_id: string;
        client_id: string;
        scopes: string[];
        requested_by: string | null;
        authn_epoch: string;
        operation_key: string;
        operation: Operation;
        digest: string;
        expires_at: Date;
        transaction_id: string;
      }>(
        `SELECT actor_id::text,client_id,scopes,requested_by,authn_epoch::text,operation_key,operation,digest,expires_at,transaction_id::text
         FROM access.workflow_approval WHERE route=$1 AND approval_id=$2`,
        [locator.route, locator.id],
      );
      const found = row.rows[0];
      if (!found) return null;
      const receipt = await facts.query<{ transaction_id: string }>(
        "SELECT transaction_id::text FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind='access.workflow-approval.create' AND idempotency_key=$3",
        [partitionOf(locator.route), found.actor_id, `${locator.route}:${locator.id}`],
      );
      return {
        actorId: found.actor_id,
        clientId: found.client_id,
        scopes: found.scopes,
        requestedBy: found.requested_by,
        epoch: found.authn_epoch,
        operationKey: found.operation_key,
        operation: found.operation,
        digest: found.digest,
        expiresAt: new Date(found.expires_at).toISOString(),
        action:
          found.operation.kind === 'organization'
            ? 'organization:create'
            : found.operation.kind === 'delete'
              ? 'account:delete'
              : found.operation.kind === 'fence-operator'
                ? 'account:suspend'
                : 'account:manage',
        resourceId:
          found.operation.kind === 'organization'
            ? PLATFORM_RESOURCE.id
            : found.operation.kind === 'delete'
              ? found.operation.accountId
              : found.operation.kind === 'fence-operator'
                ? PLATFORM_RESOURCE.id
                : found.operation.kind === 'transfer'
                  ? found.operation.previous.operatorAccountId
                  : found.operation.operatorAccountId,
        creationReceiptId: receipt.rows[0]?.transaction_id ?? found.transaction_id,
      };
    },
    async digest(work) {
      const row = await facts.query<{ digest: string }>(
        'SELECT digest FROM access.workflow_approval WHERE operation_key=$1 ORDER BY created_at DESC LIMIT 1',
        [work.operationKey],
      );
      if (row.rows[0]) return row.rows[0].digest;
      const f = operationFixtures.get(work.operationKey);
      if (!f) throw new Error(`No native fixture is bound to ${work.operationKey}`);
      const result = await driver.approve(f.caller, work);
      if (result.outcome !== 'approved') throw new Error('Native digest approval was refused');
      const saved = await facts.query<{ digest: string }>(
        'SELECT digest FROM access.workflow_approval WHERE operation_key=$1 ORDER BY created_at DESC LIMIT 1',
        [work.operationKey],
      );
      return required(saved.rows[0]?.digest, 'Native approval did not persist its digest');
    },
    async execute(caller, referenceValue, work, hook) {
      const reference = referenceValue as string;
      let f: Fixture | undefined;
      const priorObserver = stepObserver;
      let pendingCompletion = false;
      activeHook = hook ? { ...hook, used: false } : undefined;
      let releaseGate = () => {};
      let continuationPaused: (() => void) | undefined;
      let continuationPausedAtStep = false;
      const continuationReached = new Promise<void>((resolve) => {
        continuationPaused = resolve;
      });
      const executionObserver: StepObserver = async (name, args) => {
        await priorObserver?.(name, args);
        const fixture = required(f, 'Native workflow observer ran before its fixture was bound');
        activeStepTarget = stepTargetFromArgs(fixture, name, args);
        const pending = activeHook;
        if (
          pending &&
          !pending.used &&
          (pending.boundary ?? 'step') === 'step' &&
          pending.before.name === name &&
          stepTargetFromArgs(fixture, name, args) === pending.before.target
        ) {
          pending.used = true;
          activeHook = undefined;
          await hookContext.runInAsyncScope(() => pending.run());
        }
        if (work.operation.kind === 'delete' && name === 'erase-auth-owner') {
          const view = await native().continuations.read(work.operationKey, work.operation.accountId);
          const target = stepTargetFromArgs(fixture, name, args);
          if (
            view &&
            !completedCrashSteps.has(crashStepKey(fixture, name, target)) &&
            !continuedOperations.has(work.operationKey)
          ) {
            continuationPausedAtStep = true;
            continuationPaused?.();
            await new Promise<void>((resolve) => {
              releaseGate = resolve;
            });
          }
        }
      };
      stepObserver = executionObserver;
      try {
        const result = await refused(async () => {
          const nativeOperation = accountOperation(work);
          const resolved = await approvals().resolveForCaller(caller, reference, nativeOperation, context());
          const fixture = required(
            operationFixtures.get(work.operationKey) ?? bindOperationFixture(caller, work),
            'Unknown native operation fixture',
          );
          f = fixture;
          const commandKeyPrefix = required(
            native().workflowPorts.approvalBinding!(resolved),
            'Native approval has no command binding',
          ).commandKeyPrefix;
          let value: unknown;
          if (work.operation.kind === 'delete') {
            const firstAttempt = !startedDeleteOperations.has(work.operationKey);
            startedDeleteOperations.add(work.operationKey);
            const completion = firstAttempt
              ? executeWorkflow(reference, work)
              : workflows().resumeOperation(work.operationKey);
            completion.catch(() => {});
            let settled = false;
            void completion.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            const until = Date.now() + 30_000;
            let continuation: Awaited<ReturnType<ReturnType<typeof native>['continuations']['read']>> = null;
            while (!settled && Date.now() < until) {
              continuation = await native().continuations.read(work.operationKey, work.operation.accountId);
              if (continuation) break;
              await Bun.sleep(5);
            }
            if (continuation) {
              await Promise.race([
                continuationReached,
                completion.then(
                  () => undefined,
                  () => undefined,
                ),
              ]);
              if (continuationPausedAtStep) {
                pendingWorkflows.set(work.operationKey, { release: () => releaseGate(), promise: completion });
                completion
                  .finally(() => {
                    const currentPending = pendingWorkflows.get(work.operationKey);
                    if (currentPending?.promise === completion) pendingWorkflows.delete(work.operationKey);
                    if (stepObserver === executionObserver) stepObserver = priorObserver;
                  })
                  .catch(() => {});
                pendingCompletion = true;
                return { outcome: 'denied' as const };
              }
            }
            if (!settled && !continuation) throw new Error('Native account workflow did not reach its barrier');
            value = await completion;
          } else {
            value = await executeWorkflow(reference, work);
          }
          if (value && typeof value === 'object' && 'outcome' in value) return value as { outcome: 'denied' };
          const receipts = await facts.query<{ transaction_id: string; response: unknown }>(
            'SELECT transaction_id::text, response FROM core.receipt WHERE idempotency_key LIKE $1 ORDER BY created_at DESC LIMIT 1',
            [`%:${commandKeyPrefix}:%`],
          );
          const receiptId =
            (work.operation.kind !== 'opening' &&
            value &&
            typeof value === 'object' &&
            'receiptId' in value &&
            typeof value.receiptId === 'string'
              ? value.receiptId
              : undefined) ?? (receipts.rows[0] ? observedReceiptId(receipts.rows[0]) : undefined);
          if (!receiptId) throw new Error('Native workflow completed without an observable command receipt');
          return {
            outcome: 'permitted' as const,
            accountId:
              work.operation.kind === 'delete'
                ? work.operation.accountId
                : work.operation.kind === 'fence-operator'
                  ? work.operation.accountId
                  : work.operation.kind === 'opening'
                    ? work.operation.subjectAccountId
                    : 'accountId' in (value as object)
                      ? String((value as { accountId: string }).accountId)
                      : fixture.organizationId,
            receiptId,
            value,
          };
        });
        return result;
      } finally {
        if (!pendingCompletion) {
          activeHook = undefined;
          if (stepObserver === executionObserver) stepObserver = priorObserver;
          restoreEvidenceReader?.();
          restoreEvidenceReader = undefined;
        }
      }
    },
    async protectedSteps(f) {
      const existing = stepsCache.get(f);
      if (existing) return existing;
      let observed = observedStepNames.get(f.family);
      if (!observed) {
        const probe = await makeFixture(f.family);
        const captured: ProtectedStep[] = [];
        const previousObserver = stepObserver;
        stepObserver = async (name, args) => {
          await previousObserver?.(name, args);
          if (!name || name === 'operator-fence-page.run') return;
          const target = stepTargetFromArgs(probe, name, args);
          const operationAccount =
            probe.work.operation.kind === 'delete'
              ? probe.work.operation.accountId
              : probe.work.operation.kind === 'fence-operator'
                ? probe.work.operation.accountId
                : probe.ownerId;
          const continuation =
            f.family === 'subject-delete' || f.family === 'operator-delete' || f.family === 'fence-operator'
              ? await native().continuations.read(probe.work.operationKey, operationAccount)
              : null;
          captured.push({
            name,
            target,
            authority: continuation?.allowlist.some((entry) => entry.step === name)
              ? 'committed-continuation'
              : 'caller',
          });
        };
        try {
          const approval = await driver.approve(probe.caller, probe.work);
          if (approval.outcome !== 'approved')
            throw new Error(`Native ${probe.family} workflow step observation was refused`);
          await driver.execute(probe.caller, approval.reference, probe.work);
          const continuation = await driver.continuation(probe);
          const pending = pendingWorkflows.get(probe.work.operationKey);
          if (pending) {
            pending.release();
            await pending.promise.catch((error: unknown) => {
              if (!deniedError(error)) throw error;
            });
            pendingWorkflows.delete(probe.work.operationKey);
          }
          for (const entry of continuation?.allowed ?? [])
            if (!captured.some((step) => step.name === entry.step))
              captured.push({ name: entry.step, target: entry.target, authority: 'committed-continuation' });
          if (continuation && !pending) await driver.continueCommitted(continuation.reference);
        } finally {
          stepObserver = previousObserver;
        }
        observed = {
          fixture: probe,
          steps: [...new Map(captured.map((item) => [`${item.name}\0${item.target}`, item])).values()],
        };
        observedStepNames.set(f.family, observed);
      }
      const result = observed.steps.map(({ name, target, authority }) => ({
        name,
        target: translateTarget(observed.fixture, f, target),
        authority,
      }));
      stepsCache.set(f, result);
      return result;
    },
    async revoke(f, fact) {
      const operation = f.work.operation;
      const action =
        operation.kind === 'organization'
          ? 'organization:create'
          : operation.kind === 'delete'
            ? 'account:delete'
            : operation.kind === 'fence-operator'
              ? 'account:suspend'
              : operation.kind === 'opening'
                ? f.managementAction
                : 'account:manage';
      const actor = await required(accessPort, 'Access is not composed').authenticate(f.caller, context());
      if (fact === 'actor-grant' || fact === 'principal-grant') {
        const principal = actor.requestedBy ? /^urn:rezics:request:([^:]+):/.exec(actor.requestedBy)?.[1] : undefined;
        if (actor.requestedBy && !principal) throw new Error('Auth returned a malformed assignment reference');
        const who = fact === 'principal-grant' ? (principal ?? actor.accountId) : actor.accountId;
        const issuer = principal ?? actor.accountId;
        const grantor =
          operation.kind === 'organization' || f.family === 'fence-operator'
            ? required(governor, 'Platform governance is not bootstrapped').accountId
            : operation.kind === 'transfer'
              ? f.ownerId
              : issuer;
        const identity = required(registrations.get(grantor), `Missing native grant issuer session for ${grantor}`);
        const grantorClient =
          grantor === required(governor, 'Platform governance is not bootstrapped').accountId
            ? loginClient
            : f.identity.clientId;
        const session = await login(identity.email, grantorClient);
        const grantActor = await required(accessPort, 'Access is not composed').authenticate(session.bearer, context());
        const target =
          operation.kind === 'delete' && operation.responsibility && actor.accountId !== operation.accountId
            ? operation.responsibility.operatorAccountId
            : operation.kind === 'delete'
              ? operation.accountId
              : operation.kind === 'fence-operator'
                ? PLATFORM_RESOURCE.id
                : operation.kind === 'opening'
                  ? operation.operatorAccountId
                  : operation.kind === 'transfer'
                    ? operation.previous.operatorAccountId
                    : PLATFORM_RESOURCE.id;
        const targetAction =
          operation.kind === 'delete' && operation.responsibility && actor.accountId !== operation.accountId
            ? 'account:manage'
            : action;
        const revokeCommand = createGrantCommands({
          pool: kernel,
          access: required(accessPort, 'Access is not composed'),
          managementAction:
            grantActor.accountId === required(governor, 'Platform governance is not bootstrapped').accountId
              ? 'access:grant'
              : 'account:manage',
        });
        const input = {
          resource: { route: route(target), id: target },
          subject: { kind: 'account' as const, id: who },
          valid: '(,)',
          key: reference(`revoke-${fact}`),
        };
        if (f.family === 'fence-operator')
          await revokeCommand.revokeRole(
            {
              ...context(),
              actor: await required(accessPort, 'Access is not composed').authenticate(
                (await login(required(governor, 'Platform governance is not bootstrapped').email, loginClient)).bearer,
                context(),
              ),
            },
            { ...input, role: platformGovernance.role },
          );
        else await revokeCommand.revoke({ ...context(), actor: grantActor }, { ...input, actions: [targetAction] });
      } else if (fact === 'assignment') {
        if (actor.requestedBy) {
          const match = /urn:rezics:request:([^:]+):([^:]+)/.exec(actor.requestedBy);
          if (!match) throw new Error('Auth returned a malformed assignment reference');
          const command = createDelegationCommands({
            pool: kernel,
            access: required(accessPort, 'Access is not composed'),
            action: 'account:manage',
          });
          const principal = required(registrations.get(match[1]!), `Missing assignment principal ${match[1]}`);
          const principalSession = await login(principal.email, loginClient);
          const principalActor = await required(accessPort, 'Access is not composed').authenticate(
            principalSession.bearer,
            context(),
          );
          await command.revoke(
            { ...context(), actor: principalActor },
            { principalId: match[1]!, requestId: match[2]!, key: reference('assignment-revoke') },
          );
        }
      } else if (fact === 'client-consent') {
        const result = await request(
          '/consent',
          { client_id: actor.clientId, scope: scopes.filter((scope) => scope !== action) },
          await consentSession(actor.accountId),
        );
        if (!result.ok) throw new Error(`Consent reduction failed: ${result.status} ${await result.text()}`);
      } else if (fact === 'scope') {
        const key = reference('reduce-scopes');
        const reduction = {
          kind: 'client-reduction' as const,
          authorization: 'native-approval-request',
          clientId: actor.clientId,
          firstParty: false,
          scopes: scopes.filter((scope) => scope !== action),
        };
        const fresh = await approvals().approve(
          required(governor, 'Platform governance is not bootstrapped').bearer,
          { operationKey: key, operation: reduction },
          context(),
        );
        const result = await workflows().reduceClientScopes({
          key,
          authorization: fresh.reference,
          clientId: actor.clientId,
          firstParty: false,
          scopes: scopes.filter((scope) => scope !== action),
        });
        void result;
      } else if (fact === 'actor-epoch') {
        const response = await request(
          '/consent',
          { client_id: otherClient, scope: scopes.filter((scope) => scope !== action) },
          await consentSession(actor.accountId),
        );
        if (!response.ok) throw new Error(`Auth epoch barrier failed: ${response.status}`);
      } else if (fact === 'actor-fenced') {
        await native().internalLifecycle.raiseFence({ accountId: actor.accountId, key: reference('actor-fenced') });
      } else if (fact === 'missing-evidence') {
        evidenceUnavailable = true;
        const access = required(accessPort, 'Access is not composed');
        const prepare = required(access.prepare, 'Access has no authoritative evidence reader');
        const failClosed = async (...args: [Actor, string, Resource, AccessContext]) => {
          await prepare(...args);
          throw Object.assign(new Error('Native authority evidence unavailable'), { status: 503 });
        };
        access.prepare = failClosed;
        restoreEvidenceReader = () => {
          evidenceUnavailable = false;
          if (access.prepare === failClosed) access.prepare = prepare;
        };
      } else if (fact === 'operator-relation') {
        const next = await person('replacement-operator');
        if (operation.kind !== 'opening')
          throw new Error('Operator relation revocation applies only to opening fixtures');
        const previousResult = await facts.query<{
          operator_account_id: string;
          operator_reservation_id: string;
          operator_relation_version: string;
        }>(
          'SELECT operator_account_id::text,operator_reservation_id::text,operator_relation_version::text FROM access.account WHERE route=$1 AND account_id=$2',
          [route(operation.subjectAccountId), operation.subjectAccountId],
        );
        const current = previousResult.rows[0];
        if (!current?.operator_account_id || !current.operator_reservation_id)
          throw new Error('Missing native operator responsibility');
        const previous = {
          operatorAccountId: current.operator_account_id,
          subjectAccountId: operation.subjectAccountId,
          reservationId: current.operator_reservation_id,
          version: current.operator_relation_version,
        };
        const held = await native().operators.reserveResponsibility({
          operatorAccountId: next.accountId,
          subjectAccountId: operation.subjectAccountId,
          key: reference('operator-change'),
        });
        await native().operators.recordOperatorRelation({
          ...held.value,
          expectedOperatorAccountId: previous.operatorAccountId,
          expectedVersion: previous.version,
          key: reference('operator-change-record'),
        });
      } else if (fact === 'organization-membership') {
        const backup = await person('membership-backup');
        const ownerContext = await required(accessPort, 'Access is not composed').authenticate(f.caller, context());
        const ownerReservation = await native().workflowPorts.reserveCoordination!({
          accountId: backup.accountId,
          relatedAccountId: f.ownerId,
          purpose: 'membership',
          key: reference('backup-owner-hold'),
        });
        await native().workflowPorts.setMembership!(
          { ...context(), actor: ownerContext },
          {
            organizationId: f.ownerId,
            memberAccountId: backup.accountId,
            reservationId: ownerReservation.value.reservationId,
            role: 'owner',
            key: reference('backup-owner'),
          },
        );
        const backupContext = await required(accessPort, 'Access is not composed').authenticate(
          backup.bearer,
          context(),
        );
        const old = await facts.query<{ reservation_id: string }>(
          `SELECT reservation_id::text FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND related_account_id=$3 AND purpose='membership' ORDER BY reservation_id LIMIT 1`,
          [route(f.identity.actorId), f.identity.actorId, f.ownerId],
        );
        if (old.rows[0])
          await native().workflowPorts.setMembership!(
            { ...context(), actor: backupContext },
            {
              organizationId: f.ownerId,
              memberAccountId: f.identity.actorId,
              role: null,
              reservationId: old.rows[0].reservation_id,
              key: reference('remove-member'),
            },
          );
      }
    },
    async snapshot(f) {
      return observe(f);
    },
    async crashAfter(f, referenceValue, step) {
      const previous = afterStep;
      let reached!: () => void;
      const committed = new Promise<void>((resolve) => {
        reached = resolve;
      });
      afterStep = async (name, args) => {
        await previous?.(name, args);
        if (name !== step.name || stepTargetFromArgs(f, name, args) !== step.target) return;
        completedCrashSteps.add(crashStepKey(f, name, step.target));
        reached();
        // Keep the committed step from returning its DBOS acknowledgement. The
        // real executor and its database transport are shut down below.
        await new Promise<never>(() => {});
      };
      try {
        if (f.work.operation.kind === 'delete') startedDeleteOperations.add(f.work.operationKey);
        const execution = executeWorkflow(referenceValue, f.work);
        await Promise.race([
          committed,
          execution.then(async () => {
            const continuation = await native().continuations.read(f.work.operationKey, continuationAccount(f));
            if (continuation) {
              if (step.name === 'operator-responsibility-page') {
                const events = await facts.query<{
                  id: string;
                  type: string;
                  subject: string | null;
                  data: unknown;
                  recorded_at: Date;
                  position: string;
                  partition_no: number;
                  epoch: number;
                }>("SELECT * FROM core.outbox WHERE partition_no=$1 AND data->>'receiptId'=$2", [
                  partitionOf(route(continuationAccount(f))),
                  continuation.barrierReceiptId,
                ]);
                if (!events.rows.length) throw new Error('Native fencing barrier event was not observed');
                for (const row of events.rows) {
                  const event: CloudEvent = {
                    specversion: '1.0',
                    id: row.id,
                    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
                    type: row.type,
                    ...(row.subject === null ? {} : { subject: row.subject }),
                    time: row.recorded_at.toISOString(),
                    datacontenttype: 'application/json',
                    sequence: String(row.position).padStart(19, '0'),
                    data: row.data,
                  };
                  for (const effect of fenceEffects) if (effect.types.includes(event.type)) await effect.run(event);
                }
                releaseBackgroundPages?.();
                await committed;
              } else await native().continuations.continueCommitted(continuation.reference);
            }
            throw new Error(`Native workflow completed before ${step.name}`);
          }),
        ]);
        await required(host, 'Auth host is not running').workflows.close();
      } finally {
        afterStep = previous;
        activeStepName = undefined;
      }
      // Keep the product host available to the rest of the scenario. Tests that
      // need to observe durable recovery still call restart explicitly.
      await driver.restart();
    },
    async restart() {
      await fenceClient?.close();
      fenceClient = undefined;
      if (host) await host.stop();
      host = undefined;
      bindings = undefined;
      approvalPort = undefined;
      await buildHost();
    },
    async continuation(f) {
      const accountId = continuationAccount(f);
      const view = await native().continuations.read(f.work.operationKey, accountId);
      if (!view) return null;
      continuationOwners.set(view.reference, f);
      return {
        reference: view.reference,
        operationKey: view.operationKey,
        operationDigest: view.operationDigest,
        barrierReceiptId: view.barrierReceiptId,
        expiresAt: view.expiresAt,
        allowed: await continuationAllowlist(f, view.allowlist),
      };
    },
    async continueCommitted(referenceValue, override, hook) {
      try {
        const f = continuationOwners.get(referenceValue);
        if (!f) {
          await native().continuations.continueCommitted(referenceValue);
          return { outcome: 'continued' };
        }
        const view = await native().continuations.read(f.work.operationKey, continuationAccount(f));
        if (!view) {
          await native().continuations.continueCommitted(referenceValue);
          return { outcome: 'continued' };
        }
        if (override) {
          if (override.allowed?.length) {
            await native().continuations.authorizeStep(referenceValue, override.allowed[0]!);
          } else {
            const sealed = unseal(referenceKeys, 'access.committed-continuation.v1', referenceValue) as
              | { route: number; continuationId: string; digest: string }
              | undefined;
            const forged = seal(referenceKeys, 'access.committed-continuation.v1', {
              ...sealed,
              ...override,
            });
            await native().continuations.continueCommitted(forged);
          }
          return { outcome: 'continued' };
        }
        if (hook) activeHook = { ...hook, boundary: 'step', used: false };
        releaseBackgroundPages?.();
        const pending = pendingWorkflows.get(f.work.operationKey);
        if (pending) {
          pending.release();
          const outcome = await pending.promise.then(
            () => undefined,
            (error: unknown) => error,
          );
          if (outcome !== undefined && !deniedError(outcome)) throw outcome;
          pendingWorkflows.delete(f.work.operationKey);
        }
        await native().continuations.continueCommitted(referenceValue);
        if (f) continuedOperations.add(f.work.operationKey);
        activeHook = undefined;
        return { outcome: 'continued' };
      } catch (error) {
        activeHook = undefined;
        if (deniedError(error)) return { outcome: 'denied' };
        throw error;
      }
    },
    async continuationEffects(f) {
      const result = await facts.query<{
        step: string;
        target: string;
        key: string;
        digest: string;
        receiptId: string;
      }>(
        `SELECT completion.step, completion.target, completion.key, completion.digest,
                completion.receipt_id::text AS "receiptId"
         FROM access.committed_continuation_completion AS completion
         JOIN access.committed_continuation AS continuation
           USING (route, continuation_id)
         WHERE continuation.route=$1 AND continuation.operation_key=$2
         ORDER BY completion.step, completion.target, completion.key`,
        [route(continuationAccount(f)), f.work.operationKey],
      );
      return result.rows;
    },
    async awaitExpiry(referenceValue) {
      const approval = await driver.approval(referenceValue);
      const f = continuationOwners.get(referenceValue);
      const view = f ? await native().continuations.read(f.work.operationKey, continuationAccount(f)) : null;
      const expiresAt = approval?.expiresAt ?? view?.expiresAt;
      if (!expiresAt) throw new Error('Cannot locate native expiry for reference');
      await Bun.sleep(Math.max(0, Date.parse(expiresAt) - Date.now() + 5));
    },
    async access(f) {
      const access = required(accessPort, 'Access is not composed');
      const actor = await access.authenticate(f.caller, context());
      const openingAllowed = async (operatorAccountId: string) => {
        const identity = registrations.get(operatorAccountId);
        const session = identity
          ? await login(identity.email, f.identity.clientId).catch((error: unknown) => {
              if (
                typeof error === 'object' &&
                error !== null &&
                'status' in error &&
                (error.status === 401 || error.status === 403)
              )
                return null;
              throw error;
            })
          : undefined;
        if (session === null) return false;
        const operatorActor = identity
          ? await access.authenticate(required(session, 'Operator login has no session').bearer, context())
          : actor;
        return native().workflowPorts.authorizeOpening!(
          { ...context(), actor: operatorActor },
          {
            operatorAccountId,
            subjectAccountId: f.subjectId,
            purpose: 'session',
            key: reference('access-check'),
          },
        ).then(
          () => true,
          (error: unknown) => {
            if (deniedError(error)) return false;
            throw error;
          },
        );
      };
      const canAccess = async (accountId: string, action: string) => {
        const resource = { route: route(accountId), id: accountId };
        const evidence = await access.prepare!(actor, action, resource, context());
        return withConnection(kernel, (client) => access.authorize(client, actor, action, resource, evidence));
      };
      const oldManagement = await openingAllowed(f.ownerId);
      const newManagement = await openingAllowed(f.nextOperatorId);
      const sessionAccountId =
        f.work.operation.kind === 'transfer'
          ? f.work.operation.previous.subjectAccountId
          : f.work.operation.kind === 'fence-operator'
            ? f.ownerId
            : f.subjectId;
      const originalSession = registrations.get(sessionAccountId)?.session;
      const oldSession = originalSession ? await request('/token', {}, originalSession) : undefined;
      const independentSession = registrations.get(f.subjectId)?.session;
      const independent = independentSession ? await request('/token', {}, independentSession) : undefined;
      return {
        oldManagement,
        newManagement,
        oldSessionsValid: oldSession?.ok ?? false,
        independentLogin: independent?.ok ?? false,
        inheritedResourceAccess: await canAccess(f.subjectId, 'account:manage'),
      };
    },
    async lastOwner(f, action) {
      const actor = await required(accessPort, 'Access is not composed').authenticate(f.caller, context());
      try {
        if (action === 'suspend') {
          const command = await import('../../src/access/suspension.ts');
          const access = required(accessPort, 'Access is not composed');
          const value = await command
            .createSuspensionCommands({ pool: kernel, access, clock: () => new Date() })
            .suspend(
              {
                ...context(),
                actor: await access.authenticate(required(governor, 'No platform governor').bearer, context()),
              },
              { accountId: f.identity.actorId, key: reference('last-owner-suspend') },
            );
          return {
            outcome: 'permitted',
            accountId: f.identity.actorId,
            receiptId: value.value.receiptId,
            value: value.value,
          };
        }
        if (action === 'delete') {
          const value = await native().workflowPorts.tombstone!(
            { ...context(), actor },
            { accountId: f.identity.actorId, key: reference('last-owner-delete') },
          );
          return {
            outcome: 'permitted',
            accountId: f.identity.actorId,
            receiptId: value.value.receiptId,
            value: value.value,
          };
        }
        const membership = await facts.query<{ reservation_id: string }>(
          `SELECT reservation_id::text FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND related_account_id=$3 AND purpose='membership' ORDER BY reservation_id LIMIT 1`,
          [route(f.identity.actorId), f.identity.actorId, f.organizationId],
        );
        const operation: Operation = { kind: 'organization', handle: f.handle };
        void operation;
        const role = action === 'remove' ? null : 'member';
        await native().workflowPorts.setMembership!(
          { ...context(), actor },
          {
            organizationId: f.organizationId,
            memberAccountId: f.identity.actorId,
            reservationId: membership.rows[0]?.reservation_id ?? '',
            role,
            key: reference('last-owner-membership'),
          },
        );
        throw new Error('Native last-owner command unexpectedly committed');
      } catch (error) {
        if (deniedError(error)) return { outcome: 'denied' };
        throw error;
      }
    },
    async consumeOpening(f, mismatch) {
      if (f.work.operation.kind !== 'opening') throw new Error('Opening consumption requires a native opening fixture');
      const identity = registrations.get(f.identity.actorId);
      if (!identity) throw new Error('Missing Auth session for native opening');
      const operationKey = f.work.operationKey;
      const operation = { ...f.work.operation };
      if (mismatch === 'subject') operation.subjectAccountId = f.otherSubjectId;
      if (mismatch === 'relation') operation.operatorAccountId = f.nextOperatorId;
      const caller = mismatch === 'epoch' ? (staleCallerTokens.get(f) ?? f.caller) : f.caller;
      const approval = await driver.approve(caller, f.work);
      if (approval.outcome !== 'approved') return { outcome: 'denied' };
      let response: Response | { outcome: 'denied' };
      if (mismatch === 'purpose' || mismatch === 'subject' || mismatch === 'relation') {
        const result = await refused(async () => {
          const resolved = await approvals().resolveForCaller(
            caller,
            approval.reference,
            accountOperation(f.work),
            context(),
          );
          const issued = await native().workflowPorts.authorizeOpening!(resolved, {
            operatorAccountId: operation.operatorAccountId,
            subjectAccountId: operation.subjectAccountId,
            purpose: (mismatch === 'purpose' ? 'credential-management' : 'session') as 'session',
            key: native().workflowPorts.stableCommandKey!(resolved, 'session-opening'),
          });
          return auth().internal.openAutomatedSession({
            authorization: issued.value.receiptId,
            subjectAccountId: operation.subjectAccountId,
            headers: identity.session,
          });
        });
        response = result;
      } else {
        const headers =
          mismatch === 'human'
            ? registrations.get(f.otherSubjectId)!.session
            : mismatch === 'client'
              ? identity.otherSession!
              : identity.session;
        response = await refused(async () => {
          const opening = await workflows().authorizeOperatorOpening({
            key: operationKey,
            authorization: approval.reference,
            operatorAccountId: operation.operatorAccountId,
            subjectAccountId: operation.subjectAccountId,
          });
          return auth().internal.openAutomatedSession({
            authorization: opening.receiptId,
            subjectAccountId: operation.subjectAccountId,
            headers,
          });
        });
      }
      if ('outcome' in response) return response;
      if (response.status === 403) return { outcome: 'denied' };
      if (!response.ok) throw new Error(`Native opening failed: ${response.status} ${await response.text()}`);
      const receipt = await facts.query<{ transaction_id: string; response: unknown }>(
        "SELECT transaction_id::text, response FROM core.receipt WHERE command_kind='access.operator.opening-authorized' AND actor_account_id=$1 ORDER BY created_at DESC LIMIT 1",
        [f.identity.actorId],
      );
      const receiptId = observedReceiptId(required(receipt.rows[0], 'Native opening produced no command receipt'));
      return {
        outcome: 'permitted',
        accountId: f.subjectId,
        receiptId,
        value: { status: response.status },
      };
    },
    async page(f, limit, cursor, mismatch) {
      const viewer = await required(accessPort, 'Access is not composed').authenticate(f.caller, context());
      let supplied = cursor;
      if (mismatch === 'bytes') supplied = `${cursor ?? ''}x`;
      if (mismatch === 'epoch' && cursor) {
        const binding = {
          route: 'access.operator.responsibility.list',
          viewer: viewer.kind === 'account' ? viewer.accountId : null,
          query: { operatorAccountId: f.ownerId, purpose: 'operator', sort: 'reservationId:asc', limit },
        };
        const decoded = await decodeListCursor(referenceKeys, binding, cursor, new Date());
        if (!decoded.ok) throw new Error('Native page returned an invalid opaque cursor');
        supplied = await encodeListCursor(
          referenceKeys,
          binding,
          { epoch: decoded.epoch + 1, after: decoded.after },
          new Date(),
        );
      }
      return refused(async () => {
        const value = await native().operators.responsibilityPage(
          {
            operatorAccountId: mismatch === 'operator' ? f.nextOperatorId : f.ownerId,
            limit,
            ...(supplied === undefined ? {} : { cursor: supplied }),
          },
          viewer,
        );
        return {
          operators: value.operators.map((x) => ({
            reservationId: x.reservationId,
            subjectAccountId: x.subjectAccountId,
          })),
          next: value.next,
        };
      });
    },
    async durableState(f) {
      const dbos = await proofsPool!.query<{ total: string; document: string }>(
        `SELECT count(*)::text AS total,COALESCE(string_agg(coalesce(inputs::text,'')||coalesce(output::text,'')||coalesce(error::text,''),' '),'') AS document FROM auth_dbos.workflow_status`,
      );
      const approvalRows = await facts.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM access.workflow_approval',
      );
      const document = dbos.rows[0]?.document ?? '';
      return {
        records: Number(dbos.rows[0]?.total ?? 0),
        approvals: Number(approvalRows.rows[0]?.count ?? 0),
        bearerTokens: /Bearer\s+[A-Za-z0-9._-]+/.test(document) ? 1 : 0,
        refreshTokens: /refresh[_-]?token/i.test(document) ? 1 : 0,
        credentials: /password|credential|privateKey/i.test(document) ? 1 : 0,
        actorContexts: /requestedBy|authnEpoch|scopes/.test(document) ? 1 : 0,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const pending = [...pendingWorkflows.values()];
      for (const workflow of pending) workflow.release();
      await Promise.allSettled(pending.map((workflow) => workflow.promise));
      pendingWorkflows.clear();
      try {
        releaseBackgroundPages?.();
        await fenceClient?.close();
        fenceClient = undefined;
        await host?.stop();
      } finally {
        await proofsPool?.end().catch(() => {});
        proofsPool = undefined;
        await authPool?.end().catch(() => {});
        authPool = undefined;
        await kernel.end().catch(() => {});
        kernel = undefined as unknown as ReturnType<typeof createPool>;
        await facts.end().catch(() => {});
        facts = undefined as unknown as Pool;
        // Pool.end releases its clients before their server sockets necessarily
        // finish closing. Observe disconnects before dropping our databases so
        // teardown cannot turn an ending idle client into an unhandled error.
        const until = Date.now() + 10_000;
        while (true) {
          const connections = await admin.query<{ total: number }>(
            'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=ANY($1::text[])',
            [[authDatabase, kernelDatabase]],
          );
          if (connections.rows[0]?.total === 0) break;
          if (Date.now() >= until) throw new Error('Owned native fixture database connections did not close');
          await Bun.sleep(10);
        }
        await admin.query(`DROP DATABASE "${authDatabase}"`);
        await admin.query(`DROP DATABASE "${kernelDatabase}"`);
        await admin.end().catch(() => {});
        admin = undefined as unknown as Pool;
        host = undefined;
        service = undefined;
        bindings = undefined;
        accessPort = undefined;
        approvalPort = undefined;
      }
    },
  };
  return driver;
}

function stepTarget(f: Fixture, name: string): string {
  const operation = f.work.operation;
  if (name === 'operator-responsibility-page') return f.ownerId;
  if (name === 'erase-auth-owner' || name === 'tombstone-account' || name === 'account-before-deletion')
    return operation.kind === 'delete' ? operation.accountId : f.subjectId;
  if (name === 'retire-operator')
    return operation.kind === 'delete' && operation.responsibility
      ? operation.responsibility.subjectAccountId
      : f.subjectId;
  if (name === 'release-operator')
    return operation.kind === 'delete' && operation.responsibility
      ? operation.responsibility.operatorAccountId
      : f.ownerId;
  if (name === 'redirect-deleted-handle') return f.handle;
  if (name === 'create-organization' || name === 'reserve-owner' || name.includes('handle')) return f.organizationId;
  if (name === 'fence' || name === 'revoke-auth-sessions')
    return operation.kind === 'fence-operator' ? operation.accountId : f.subjectId;
  if (name.includes('owner') || name.includes('membership')) return f.organizationId || f.ownerId;
  if (name.includes('operator')) return f.subjectId;
  if (name.includes('session') || name.includes('account')) return f.ownerId;
  if (name === 'authorize-opening') return f.subjectId;
  return f.organizationId || f.subjectId || f.ownerId;
}

function translateTarget(from: Fixture, to: Fixture, target: string): string {
  const fields = ['ownerId', 'nextOperatorId', 'subjectId', 'otherSubjectId', 'organizationId', 'handle'] as const;
  for (const field of fields) if (target === from[field]) return to[field];
  return target;
}

function stepTargetFromArgs(f: Fixture, name: string, args: unknown[]): string {
  const target = stepTarget(f, name);
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      ids.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') for (const field of Object.values(value)) visit(field);
  };
  for (const arg of args) visit(arg);
  return ids.includes(target) || ids.length === 0 ? target : ids[0]!;
}

async function observe(f: Fixture): Promise<Snapshot> {
  const ids = new Set([
    f.ownerId,
    f.nextOperatorId,
    f.subjectId,
    f.otherSubjectId,
    f.organizationId,
    f.identity.actorId,
  ]);
  const operated = await facts.query<{ account_id: string }>(
    `SELECT related_account_id::text AS account_id FROM access.lifecycle_coordination
     WHERE purpose='operator' AND account_id=ANY($1::uuid[])
     UNION SELECT subject_account_id::text FROM access.operator_relation_slot WHERE operator_account_id=ANY($1::uuid[])`,
    [[...ids]],
  );
  for (const row of operated.rows) ids.add(row.account_id);
  const all = await facts.query<{
    account_id: string;
    kind: string;
    state: string;
    authn_fenced: boolean;
    minimum_authn_epoch: string;
    operator_account_id: string | null;
    operator_relation_version: string;
  }>(
    'SELECT account_id::text,kind,state,authn_fenced,minimum_authn_epoch::text,operator_account_id::text,operator_relation_version::text FROM access.account WHERE account_id = ANY($1::uuid[]) ORDER BY account_id',
    [[...ids]],
  );
  const responsibilitiesRows = await facts.query<{
    operator_account_id: string;
    subject_account_id: string;
    reservation_id: string;
    terminal: boolean;
    held: boolean;
  }>(
    `SELECT COALESCE(c.account_id,s.operator_account_id)::text AS operator_account_id,
       COALESCE(c.related_account_id,s.subject_account_id)::text AS subject_account_id,
       COALESCE(c.reservation_id,s.reservation_id)::text AS reservation_id,
       COALESCE(s.terminal,false) AS terminal,c.reservation_id IS NOT NULL AS held
     FROM (SELECT * FROM access.lifecycle_coordination WHERE purpose='operator') c
     FULL JOIN access.operator_relation_slot s ON s.subject_account_id=c.related_account_id
       AND s.operator_account_id=c.account_id AND s.reservation_id=c.reservation_id
     WHERE COALESCE(c.account_id,s.operator_account_id)=ANY($1::uuid[])
       OR COALESCE(c.related_account_id,s.subject_account_id)=ANY($1::uuid[]) ORDER BY 1,2,3`,
    [[...ids]],
  );
  const membership = await facts.query<{
    organization_id: string;
    member_account_id: string;
    role: 'owner' | 'member';
    reservation_id: string;
  }>(
    `SELECT m.organization_id::text,m.member_account_id::text,m.role,c.reservation_id::text FROM access.organization_member m
     JOIN access.lifecycle_coordination c ON c.account_id=m.member_account_id AND c.related_account_id=m.organization_id AND c.purpose='membership'
     WHERE (m.organization_id=ANY($1::uuid[]) OR m.member_account_id=ANY($1::uuid[]))
       AND m.valid @> clock_timestamp() ORDER BY m.organization_id,m.member_account_id`,
    [[...ids]],
  );
  const ownerInverses = await facts.query<{
    organization_id: string;
    owner_id: string;
    reservation_id: string;
    terminal: boolean;
  }>(
    `SELECT c.related_account_id::text AS organization_id,c.account_id::text AS owner_id,
       c.reservation_id::text,COALESCE(s.terminal,false) AS terminal
     FROM access.lifecycle_coordination c LEFT JOIN access.lifecycle_membership_slot s
       ON s.organization_id=c.related_account_id AND s.member_account_id=c.account_id AND s.reservation_id=c.reservation_id
     WHERE c.purpose='membership' AND c.related_account_id=$1 ORDER BY c.account_id,c.reservation_id`,
    [f.organizationId],
  );
  const handleRows = await facts.query<{ handle: string; account_id: string; phase: string }>(
    `SELECT normalized_handle AS handle,account_id::text,state AS phase FROM access.handle_claim WHERE account_id=ANY($1::uuid[]) OR normalized_handle=$2 ORDER BY normalized_handle,account_id`,
    [[...ids], f.handle],
  );
  const receipts = await facts.query<{
    transaction_id: string;
    command_kind: string;
    idempotency_key: string;
    request_digest: Buffer;
    response: unknown;
    business_receipt_id: string | null;
    effect_key: string | null;
    effect_digest: string | null;
  }>(
    `SELECT transaction_id::text,command_kind,
            COALESCE(completion.effect_key,idempotency_key) AS idempotency_key,
            COALESCE(completion.effect_digest,encode(request_digest,'hex')) AS request_digest,
            response,completion.business_receipt_id,completion.effect_key,completion.effect_digest
     FROM core.receipt
     LEFT JOIN LATERAL (
       SELECT item.receipt_id::text AS business_receipt_id,item.key AS effect_key,item.digest AS effect_digest
       FROM access.committed_continuation_completion AS item
       JOIN access.committed_continuation AS continuation USING (route, continuation_id)
       LEFT JOIN access.lifecycle_fence_receipt AS fence
         ON fence.receipt_id=item.receipt_id
        AND fence.account_id=CASE WHEN item.step='fence' THEN split_part(item.target, ':', 1)::uuid END
       WHERE continuation.route=$3 AND continuation.operation_key=$4
         AND COALESCE(fence.transaction_id,item.receipt_id)=core.receipt.transaction_id
       LIMIT 1
     ) AS completion ON true
     WHERE (actor_account_id=ANY($1::uuid[]) OR principal_id=ANY($1::uuid[]) OR response::text LIKE ANY($2::text[])
       OR completion.business_receipt_id IS NOT NULL)
       AND command_kind NOT LIKE 'access.workflow-approval.%'
       AND command_kind NOT LIKE 'access.grant.%'
       AND command_kind NOT LIKE 'access.role-grant.%'
       AND command_kind NOT LIKE 'access.delegation.%'
       AND command_kind NOT LIKE 'access.standing-parent.%'
     ORDER BY transaction_id`,
    [[...ids], [...ids].map((id) => `%${id}%`), route(continuationAccount(f)), f.work.operationKey],
  );
  const ownerRows = await facts.query<{ organization_id: string; member_account_id: string; reservation_id: string }>(
    `SELECT m.organization_id::text,m.member_account_id::text,c.reservation_id::text FROM access.organization_member m
     JOIN access.lifecycle_coordination c ON c.account_id=m.member_account_id AND c.related_account_id=m.organization_id AND c.purpose='membership'
     WHERE m.organization_id=$1 AND m.role='owner' AND m.valid @> clock_timestamp() ORDER BY m.member_account_id`,
    [f.organizationId],
  );
  const authEffects = await required(proofsPool, 'Auth observation pool is unavailable').query(
    `SELECT receipt_id,account_id,purpose,minimum_authn_epoch FROM auth_effect_receipt
     WHERE account_id=ANY($1::text[]) ORDER BY account_id,receipt_id`,
    [[...ids]],
  );
  const history = await facts
    .query(
      `SELECT 'membership' AS kind,organization_id::text AS resource_id,member_account_id::text AS account_id,role,lower(valid)::text AS lower,upper(valid)::text AS upper,transaction_id::text FROM access.organization_member WHERE organization_id=ANY($1::uuid[]) OR member_account_id=ANY($1::uuid[])
     UNION ALL SELECT 'grant',resource_id::text,subject_id::text,action,lower(valid)::text,upper(valid)::text,transaction_id::text FROM access.resource_grant WHERE resource_id=ANY($1::uuid[]) OR subject_id=ANY($1::uuid[])
     ORDER BY 1,2,3,7`,
      [[...ids]],
    )
    .then((x) => x.rows);
  const responsibility = responsibilitiesRows.rows.map((row) => ({
    operatorAccountId: row.operator_account_id,
    subjectAccountId: row.subject_account_id,
    reservationId: row.reservation_id,
    terminal: row.terminal,
    held: row.held,
  }));
  const members = membership.rows.map((row) => ({
    organizationId: row.organization_id,
    accountId: row.member_account_id,
    role: row.role,
    reservationId: row.reservation_id,
  }));
  const activeHumans = all.rows
    .filter((row) => row.kind === 'actor' && row.state === 'active')
    .map((row) => row.account_id)
    .sort();
  const ownerIds = new Set(ownerRows.rows.map((row) => row.organization_id));
  return {
    accounts: all.rows.map((row) => ({
      id: row.account_id,
      kind: row.kind === 'actor' ? 'human' : 'organization',
      state: row.state,
      fenced: row.authn_fenced,
      floor: row.minimum_authn_epoch,
      operatorId: row.operator_account_id,
      version: row.operator_relation_version,
    })),
    responsibilities: responsibility,
    ownerInverses: ownerInverses.rows.map((row) => ({
      organizationId: row.organization_id,
      ownerId: row.owner_id,
      reservationId: row.reservation_id,
      held: true,
      terminal: row.terminal,
    })),
    memberships: members,
    owners: [...ownerIds].map((organizationId) => ({
      organizationId,
      nativeCount: ownerRows.rows.filter((row) => row.organization_id === organizationId).length,
      activeHumans: activeHumans.filter((id) =>
        ownerRows.rows.some((row) => row.organization_id === organizationId && row.member_account_id === id),
      ),
    })),
    handles: handleRows.rows.map((row) => ({ handle: row.handle, accountId: row.account_id, phase: row.phase })),
    history,
    receipts: receipts.rows.map((row) => ({
      id: row.business_receipt_id ?? observedReceiptId(row),
      kind: row.command_kind,
      key: row.idempotency_key,
      digest: row.request_digest.toString(),
      transactionId: row.transaction_id,
      response: row.response,
    })),
    authEffects: authEffects.rows,
  };
}
