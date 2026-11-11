import type { AccountActor } from '../../src/request/access.ts';
import { releaseDigest } from '@rezics/definitions';
import {
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
} from '@rezics/auth';
import { bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Pool } from 'pg';
import type { HttpResponse, Persona, Release, SemanticDriver } from '../../../../specs/semantic-driver.ts';
import { accessClock, accessActionCatalogue, createAccess } from '../../src/access/index.ts';
import {
  bootstrapGovernance,
  PLATFORM_GOVERNANCE_ROLE,
  PLATFORM_RESOURCE,
} from '../../src/access/bootstrap-governance.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { admitGroup, PlatformClosedError } from '../../src/access/gates/admission.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { systemClock, type KernelClock } from '../../src/clock.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { routeOf } from '../../src/route/route.ts';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { setupContent } from '../../src/content/setup.ts';
import { sharedAuth, type OwnedResourceObserver } from './outcome-auth.ts';
import { isolatedOutcomeAuth } from './isolated-outcome-auth.ts';

type Account = { accountId: string; bearer: string };
export const releasedDiscoveryFeatures = Object.freeze([
  'personal_library',
  'reading_progress',
  'search',
  'search_advanced',
  'zone_sources',
] as const);
export type ReleasedDiscoveryFeature = (typeof releasedDiscoveryFeatures)[number];

const password = 'semantic outcome registration password with enough entropy';
const clientId = 'semantic-outcomes';
let nativePreloadInstalled = false;

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function databaseUrl(source: URL, name: string): string {
  const value = new URL(source);
  value.pathname = `/${name}`;
  return value.href;
}

async function assertDatabaseNameAvailable(owner: Pool, name: string): Promise<void> {
  const result = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (result.rowCount) throw new Error(`Semantic outcome database name is already in use: ${name}`);
}

async function jsonResponse(response: Response): Promise<HttpResponse> {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

type Tracked = { settled: Promise<void>; close(): Promise<void> };
/** Every driver whose setup has begun and that nobody has closed yet. */
const tracked = new Set<Tracked>();
let started = 0;

/** With SEMANTIC_DRIVER_TIMINGS naming a file, each driver appends one line of per-phase wall time. */
function phaseTimer() {
  const phases = new Map<string, number>();
  let last = performance.now();
  return {
    mark(name: string) {
      const now = performance.now();
      phases.set(name, (phases.get(name) ?? 0) + now - last);
      last = now;
    },
    report(number: number) {
      const file = process.env.SEMANTIC_DRIVER_TIMINGS;
      if (!file) return;
      const line = [...phases].map(([name, ms]) => `${name} ${Math.round(ms)}ms`).join(', ');
      appendFileSync(file, `driver ${number}: ${line}, load ${loadavg()[0]!.toFixed(1)}\n`);
    },
    closed(number: number) {
      const file = process.env.SEMANTIC_DRIVER_TIMINGS;
      if (file) appendFileSync(file, `driver ${number}: closed in ${Math.round(performance.now() - last)}ms\n`);
    },
  };
}

export type SemanticOutcomeDriver = SemanticDriver & {
  readonly fixtures: {
    pool: Pool;
    /** Shared Auth registration owner; Grants and rate-tier changes use this account. */
    governor: Account;
    runtime: {
      databaseUrl: string;
      routeKey: string;
      sessionKeys: string;
      authIssuer: string;
      authAudience: string;
      authJwksUrl: string;
    };
    /** Mounted platform.governance actions plus access:grant and gate:any. */
    governorScopes: readonly string[];
    person(name: string, options?: { scopes?: readonly string[] }): Promise<Account>;
    verifiedAutomated(name: string, operator: Account): Promise<Account>;
    signIn(account: Account): Promise<HttpResponse>;
    authenticatedAccount(account: Account): Promise<AccountActor>;
    scopeVariant(account: Account, scopes: readonly string[]): Promise<Account>;
    openFeatures(groups: readonly ReleasedDiscoveryFeature[]): Promise<void>;
    grantAccount(account: Account, actions: string[], resourceId?: string): Promise<void>;
    handle(request: Request): Promise<Response>;
    send(
      account: Account | null,
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<HttpResponse>;
  };
};

export type SemanticOutcomeOptions = {
  clock?: KernelClock;
  /** Named development gate grants for the original fourteen semantic capability scenarios only. */
  originalCapabilities?: boolean;
  /** Actual HTTP/relay runtime pool; fixture seeding and inspection keep their own pool. */
  kernelPool?: (url: string) => Pool | Promise<Pool>;
  /** Keep Auth's process-global SDK out of an in-process default kernel worker. */
  isolatedAuth?: boolean;
  linkProjection?: 'owned' | 'external';
  beforeClose?: () => Promise<void>;
  onOwnedResource?: OwnedResourceObserver;
  strictCleanup?: boolean;
};

/** A caller can abandon a pending call (a hook that timed out), so the next call first lets that setup finish,
 * then closes it. Otherwise its host and database outlive the caller and the next setup collides with them. */
export function createSemanticDriver(
  compose: typeof createKernel = createKernel,
  options: SemanticOutcomeOptions = {},
): Promise<SemanticOutcomeDriver> {
  const earlier = [...tracked];
  const entry: Tracked = { settled: Promise.resolve(), close: async () => {} };
  const starting = (async () => {
    await Promise.all(earlier.map((previous) => previous.settled));
    for (const previous of earlier) {
      await previous.close();
      tracked.delete(previous);
    }
    return startDriver(entry, compose, options);
  })();
  entry.settled = starting.then(
    () => {},
    () => {},
  );
  tracked.add(entry);
  return starting;
}

async function startDriver(
  entry: Tracked,
  compose: typeof createKernel,
  options: SemanticOutcomeOptions,
): Promise<SemanticOutcomeDriver> {
  const timer = phaseTimer();
  const number = ++started;
  let source: URL | undefined;
  let kernelName: string | undefined;
  let owner: Pool | undefined;
  const owned: string[] = [];
  let pool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let release: (() => void | Promise<void>) | undefined;
  let relays: ReturnType<typeof startRelays> | undefined;
  let completion: Promise<void> | undefined;
  const close = () => {
    if (completion) return completion;
    completion = (async () => {
      timer.mark('rest');
      const errors: unknown[] = [];
      const attempt = async (step: () => unknown | Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(async () => options.beforeClose?.());
      await attempt(async () => release?.());
      await attempt(async () => relays?.stop());
      if (runtimePool && runtimePool !== pool) await attempt(() => runtimePool!.end());
      await attempt(async () => pool?.end());
      if (owner) {
        for (const name of owned.reverse()) await attempt(() => dropTestDatabase(owner!, name));
        await attempt(() => owner!.end());
      }
      timer.closed(number);
      tracked.delete(entry);
      if (options.strictCleanup && errors.length)
        throw new AggregateError(errors, 'Semantic outcome fixture cleanup failed');
    })();
    return completion;
  };
  entry.close = close;

  try {
    source = new URL(required(process.env.DATABASE_URL, 'DATABASE_URL must name the migrated test database'));
    const template = decodeURIComponent(source.pathname.slice(1));
    if (!/^[A-Za-z0-9_]+$/.test(template)) throw new Error('Unsafe template database name');

    const suffix = randomUUID().replaceAll('-', '');
    kernelName = `semantic_${suffix}`;
    owner = new Pool({ connectionString: databaseUrl(source, 'postgres'), max: 1 });
    await assertDatabaseNameAvailable(owner, kernelName);
    await options.onOwnedResource?.({ kind: 'kernel_database', name: kernelName });
    owned.push(kernelName);
    await owner.query(`CREATE DATABASE "${kernelName}" TEMPLATE "${template}"`);
    const kernelUrl = databaseUrl(source, kernelName);
    pool = createPool(kernelUrl);
    configureTestReceiptKeys(pool);
    runtimePool = options.kernelPool ? await options.kernelPool(kernelUrl) : pool;
    const receiptKeyEnv = [...testReceiptKeys().keys]
      .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
      .join(',');
    process.env.KERNEL_RECEIPT_KEYS = receiptKeyEnv;
    configureTestReceiptKeys(pool);
    if (runtimePool !== pool) configureTestReceiptKeys(runtimePool);
    timer.mark('kernel database');

    if (!nativePreloadInstalled) {
      installNativeHistoryPreload();
      nativePreloadInstalled = true;
    }

    const routeKey = randomBytes(32);
    const sessionKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const receiptKeys = testReceiptKeys();
    const auth = options.isolatedAuth
      ? await isolatedOutcomeAuth(source, kernelUrl, routeKey, sessionKeys, receiptKeys, options.onOwnedResource)
      : await sharedAuth(source, options.onOwnedResource, options.strictCleanup ?? false);
    if ('close' in auth) release = () => auth.close();
    const { issuer, audience, service, host } = auth;
    const authJwksUrl = `${issuer}/.well-known/jwks.json`;
    const serviceHandler = service.handler.bind(service);
    let runtimeAuth: { issuer: string; audience: string; jwksUrl: string } | undefined;
    let access!: ReturnType<typeof createAccess>;
    const app = compose({
      receiptKeys,
      pool: runtimePool,
      requestDeadlineMs: 30_000,
      ...(options.clock ? { clock: options.clock } : {}),
      routeKey,
      tokens: sessionKeys,
      writeRate: createWriteRateLimiter({
        secret: 'semantic-outcome-write-rate-secret-with-at-least-32-bytes',
        overrides: JSON.stringify({
          anonymous: { write: { maximum: 1_000_000, seconds: 60 } },
          'new-account': { write: { maximum: 1_000_000, seconds: 60 } },
          member: { write: { maximum: 1_000_000, seconds: 60 } },
          trusted: { write: { maximum: 1_000_000, seconds: 60 } },
          service: { write: { maximum: 1_000_000, seconds: 60 } },
        }),
      }),
      access(config) {
        access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: authJwksUrl,
            // Capture the service handler before any later page wrap. Kernel
            // Access verifies JWKS through this exact transport, matching the
            // library outcome driver's in-process Auth fetch.
            fetch: (url: string | URL, init?: RequestInit) => serviceHandler(new Request(url, init)),
          },
        });
        runtimeAuth = { issuer, audience, jwksUrl: authJwksUrl };
        return access;
      },
    });

    const scopes = [...actionCatalogue(app).keys()].filter((scope) => scope !== 'media:complete');
    for (const action of LIFECYCLE_ACTIONS.keys()) if (!scopes.includes(action)) scopes.push(action);
    if (!scopes.includes('access:grant')) scopes.push('access:grant');
    // Kernel Access is lazy. Resolve it through an ordinary public read after
    // composition, retaining exactly the instance returned by access(config).
    // The empty migrated template may have no active release yet.
    await (await app.handle(new Request('http://kernel.test/v1/definitions/active'))).arrayBuffer();
    required(access, 'Kernel did not construct its native Access');
    const compiledGovernance = resourceRoleCatalogue(access)?.roles.get(PLATFORM_GOVERNANCE_ROLE);
    if (!compiledGovernance?.includes('access:grant') || !compiledGovernance.includes('subject:create'))
      throw new Error(
        `platform.governance is missing grant actions: ${(compiledGovernance ?? []).join(', ') || '(uncompiled)'}`,
      );
    // A full-catalogue governor JWT can drop later delegated actions while still
    // authenticating exposure:open. Carry the compiled platform.governance set.
    const governanceScopes = [...new Set(['access:grant', 'gate:any', ...compiledGovernance])];
    const knownScopes = new Set([...scopes, ...governanceScopes]);
    let createAutomated:
      | ((name: string, operator: Account, email: string) => Promise<{ accountId: string }>)
      | undefined;
    if ('bind' in auth) {
      const bindingPool = runtimePool;
      const actions = accessActionCatalogue(actionCatalogue(app));
      const proofs = createNativeWorkflowProofPorts({ database: auth.database });
      const bindings = createNativeAccountBindings({
        pool: bindingPool,
        access,
        ...(options.clock ? { clock: options.clock } : {}),
        actions,
        routeKey,
        referenceKeys: sessionKeys,
        auth: () => auth.service,
        proofs: {
          workflow: proofs,
          provisioning: createProvisioningEvidenceVerifier({ database: auth.database }),
          barriers: createBarrierProofVerifier({ database: auth.database }),
        },
      });
      const approvals = createWorkflowApprovals({
        pool: bindingPool,
        access,
        actions,
        referenceKeys: sessionKeys,
        creationBinding: proofs.creationBinding,
      });
      createAutomated = async (name, operator, email) => {
        const key = `${name}-${suffix}`;
        const handle = `${name}_${suffix}`;
        const operation = {
          kind: 'automated' as const,
          registrationId: '',
          operationKey: key,
          operatorAccountId: operator.accountId,
          handle,
          authorization: 'approval-request',
        };
        const approval = await approvals.approve(
          operator.bearer,
          { operationKey: key, operation },
          { pool: bindingPool, deadline: Date.now() + 10_000 },
        );
        return auth.host.workflows.createAutomated({
          key,
          handle,
          operatorAccountId: operator.accountId,
          authorization: approval.reference,
          credential: { email, password },
        });
      };
      const kernelContext = (context: { pool: unknown; deadline: number }) => {
        if (context.pool !== bindingPool) throw new Error('Account operation context belongs to another Kernel');
        return { pool: bindingPool, deadline: context.deadline };
      };
      release = auth.bind({
        trustedAccess: bindings.trustedAccess,
        access: bindings.workflowPorts,
        accountOperations: {
          context: () => ({ pool: bindingPool, deadline: Date.now() + 10_000 }),
          approve: (token, input, context) => approvals.approve(token, input, kernelContext(context)),
          resolveForCaller: (token, reference, operation, context) =>
            approvals.resolveForCaller(token, reference, operation, kernelContext(context)),
          async admitGroup(token, group, context) {
            const bounded = kernelContext(context);
            const actor = await access.authenticate(token, bounded);
            try {
              await admitGroup({
                pool: bindingPool,
                access: () => access,
                actor,
                group,
                clientAction: 'organization:create',
                deadline: context.deadline,
                clock: accessClock(access),
              });
              return true;
            } catch (error) {
              if (error instanceof PlatformClosedError) return false;
              throw error;
            }
          },
        },
      });
    }
    await auth.registerClient(clientId, [...knownScopes]);
    timer.mark('auth side');

    type Login = { email: string } | { account_id: string };
    async function issue(login: Login, scopes: readonly string[]): Promise<string> {
      const signed = await serviceHandler(
        new Request(`${issuer}/signin`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({ ...login, password, client_id: clientId, scope: scopes }),
        }),
      );
      if (signed.status !== 200) throw new Error(`Semantic fixture sign-in failed: ${signed.status}`);
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await serviceHandler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: '{}',
        }),
      );
      if (issued.status !== 200) throw new Error(`Semantic fixture token issuance failed: ${issued.status}`);
      return ((await issued.json()) as { access_token: string }).access_token;
    }

    const credentials = new WeakMap<Account, { login: Login; scopes: readonly string[] }>();
    async function signIn(account: Account): Promise<HttpResponse> {
      if (completion) throw new Error('Semantic outcome fixture is closed');
      const original = credentials.get(account);
      if (!original) throw new Error('Sign-in requires an existing native fixture account');
      return jsonResponse(
        await serviceHandler(
          new Request(`${issuer}/signin`, {
            method: 'POST',
            headers: { origin: issuer, 'content-type': 'application/json' },
            body: JSON.stringify({ ...original.login, password, client_id: clientId, scope: original.scopes }),
          }),
        ),
      );
    }
    const people = new Map<string, { scopes: string; account: Promise<Account> }>();
    async function person(name: string, options?: { scopes?: readonly string[] }): Promise<Account> {
      const requested = options?.scopes === undefined ? scopes : options.scopes;
      if (!Array.isArray(requested)) throw new Error('Semantic fixture scopes must be an array');
      for (const scope of requested) {
        if (typeof scope !== 'string' || !knownScopes.has(scope))
          throw new Error(`Unknown semantic fixture scope: ${String(scope)}`);
      }
      const chosen = [...new Set(requested)].sort();
      const canonical = JSON.stringify(chosen);
      const existing = people.get(name);
      if (existing) {
        if (existing.scopes !== canonical)
          throw new Error(`Semantic fixture person ${name} is already bound to a different scope set`);
        return existing.account;
      }

      // Reserve the name before native registration starts, including while issuance is still pending.
      const account = Promise.resolve().then(async () => {
        const email = `${name}-${suffix}@semantic.test`;
        const result = await host.workflows.register({
          key: `${name}-${suffix}`,
          handle: `${name}_${suffix}`,
          email,
          password,
        });
        const account = { accountId: result.accountId, bearer: await issue({ email }, chosen) };
        credentials.set(account, { login: { email }, scopes: chosen });
        return account;
      });
      people.set(name, { scopes: canonical, account });
      return account;
    }

    const automatedAccounts = new Map<string, Promise<Account>>();
    function verifiedAutomated(name: string, operator: Account): Promise<Account> {
      const identity = `${operator.accountId}:${name}`;
      let account = automatedAccounts.get(identity);
      if (!account) {
        account = Promise.resolve().then(async () => {
          const create = required(createAutomated, 'Automated fixture creation needs the native Auth workflow host');
          const result = await create(name, operator, `${name}-${suffix}@semantic.test`);
          const login = { account_id: result.accountId };
          const account = { accountId: result.accountId, bearer: await issue(login, scopes) };
          credentials.set(account, { login, scopes });
          const subject = await send(
            governor,
            'POST',
            '/v1/subjects',
            { type: 'schema:SoftwareApplication', labels: { en: name } },
            { 'Idempotency-Key': key() },
          );
          if (subject.status !== 201)
            throw new Error(`Automated fixture subject failed: ${subject.status}: ${JSON.stringify(subject.body)}`);
          const verification = await send(
            account,
            'POST',
            `/v1/accounts/${account.accountId}:requestVerification`,
            {
              subject: (subject.body.subject as { id: string }).id,
              statement: 'This catalogue identity belongs to this automated reader.',
              links: [{ label: 'Evidence', url: 'https://semantic.test/stream-reader' }],
            },
            { 'Idempotency-Key': key() },
          );
          if (verification.status !== 201)
            throw new Error(
              `Automated fixture verification failed: ${verification.status}: ${JSON.stringify(verification.body)}`,
            );
          const requestId = (verification.body.verificationRequest as { id: string }).id;
          const approved = await send(
            governor,
            'POST',
            `/v1/verification-requests/${requestId}:approve`,
            {},
            { 'Idempotency-Key': key() },
          );
          if (approved.status !== 200)
            throw new Error(`Automated fixture approval failed: ${approved.status}: ${JSON.stringify(approved.body)}`);
          return account;
        });
        automatedAccounts.set(identity, account);
      }
      return account;
    }

    async function scopeVariant(account: Account, requested: readonly string[]): Promise<Account> {
      if (completion) throw new Error('Semantic outcome fixture is closed');
      const original = credentials.get(account);
      if (!original) throw new Error('Scope variants require an existing native fixture account');
      if (!Array.isArray(requested)) throw new Error('Semantic fixture scopes must be an array');
      for (const scope of requested) {
        if (!knownScopes.has(scope) || !original.scopes.includes(scope))
          throw new Error(`Scope variant must be a known subset of the original scopes: ${String(scope)}`);
      }
      const chosen = [...new Set(requested)].sort();
      const bearer = await issue(original.login, chosen);
      const actor = await access.authenticate(bearer, { pool: pool!, deadline: Date.now() + 10_000 });
      if (
        actor.kind !== 'account' ||
        actor.accountId !== account.accountId ||
        JSON.stringify([...actor.scopes].sort()) !== JSON.stringify(chosen)
      )
        throw new Error('Native scope variant changed account identity or requested scopes');
      const variant = { accountId: actor.accountId, bearer };
      credentials.set(variant, { login: original.login, scopes: chosen });
      return variant;
    }

    const [governor, editor, acceptor, steward, suspended, outsider] = await Promise.all([
      person('governor', { scopes: governanceScopes }),
      person('editor'),
      person('acceptor'),
      person('steward'),
      person('suspended'),
      person('outsider'),
    ]);
    const accounts = { editor, acceptor, steward, suspended, outsider } satisfies Record<
      Exclude<Persona, 'anonymous'>,
      Account
    >;

    const kernelPool = runtimePool;
    await setupSemantic(kernelPool, bundledRelease);
    await setupContent(kernelPool);
    await setupPresentation(kernelPool);
    await bootstrapGovernance(kernelPool, governor.accountId);

    const sessions = new Map<Exclude<Persona, 'anonymous'>, string>();
    async function send(
      account: Account | null,
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
      persona?: Exclude<Persona, 'anonymous'>,
    ): Promise<HttpResponse> {
      const requestHeaders = new Headers(headers);
      if (account) requestHeaders.set('authorization', `Bearer ${account.bearer}`);
      if (persona && sessions.has(persona)) requestHeaders.set('rezics-session-token', sessions.get(persona)!);
      if (body !== undefined) requestHeaders.set('content-type', 'application/json');
      const response = await app.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const session = response.headers.get('rezics-session-token');
      if (persona && session) sessions.set(persona, session);
      return jsonResponse(response);
    }

    const key = () => `"${randomUUID()}"`;
    const collectionExposure = await send(governor, 'POST', '/v1/platform/exposure/collections:open', undefined, {
      'Idempotency-Key': key(),
    });
    if (collectionExposure.status !== 200)
      throw new Error(
        `Collection exposure setup failed: ${collectionExposure.status}: ${JSON.stringify(collectionExposure.body)}`,
      );

    function bearerScopes(bearer: string): string[] {
      const payload = bearer.split('.')[1];
      if (!payload) return [];
      const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { scope?: unknown };
      return typeof claim.scope === 'string' ? claim.scope.split(' ').filter(Boolean) : [];
    }

    async function grantAccount(
      account: Account,
      actions: string[],
      resourceId: string = PLATFORM_RESOURCE.id,
      grantor: Account = governor,
    ) {
      const resource =
        resourceId === PLATFORM_RESOURCE.id || resourceId === GLOBAL_CONTEXT
          ? PLATFORM_RESOURCE
          : { route: routeOf(resourceId), id: resourceId };
      if (resource.route === null) throw new Error(`Cannot grant an unroutable resource: ${resourceId}`);
      const held = bearerScopes(grantor.bearer);
      const holds = (action: string) =>
        held.includes(action) || (action.startsWith('gate:') && action !== 'gate:any' && held.includes('gate:any'));
      const missing = ['access:grant', ...actions].filter((action) => !holds(action));
      if (missing.length)
        throw new Error(`Grant administration failed: 403: governor token missing scopes ${missing.join(', ')}`);
      const response = await send(
        grantor,
        'POST',
        '/v1/grants',
        {
          resource,
          subject: { kind: 'account', id: account.accountId },
          actions,
          valid: '(,)',
        },
        { 'Idempotency-Key': key() },
      );
      if (response.status !== 201) {
        const listed = await send(grantor, 'GET', `/v1/grants?resourceId=${resource.id}`);
        throw new Error(
          `Grant administration failed for ${actions.join(',')} on ${resourceId}: ${response.status}: ${JSON.stringify(response.body)}; grant read ${listed.status}; token holds ${held.length} scopes`,
        );
      }
    }

    await grantAccount(accounts.editor, ['subject:create', 'statement:propose', 'context:create']);
    await grantAccount(accounts.acceptor, ['context:accept', 'context:adopt', 'subject:merge']);
    await grantAccount(accounts.steward, ['definitions:publish', 'definitions:activate']);
    if (options.originalCapabilities) {
      await grantAccount(accounts.steward, ['gate:definition_publication']);
      await grantAccount(accounts.acceptor, ['gate:subject_identity']);
      await grantAccount(accounts.editor, ['gate:definition_publication', 'gate:subject_identity']);
    }
    await grantAccount(accounts.suspended, [
      'subject:create',
      'statement:propose',
      'context:create',
      'context:accept',
      'context:adopt',
      'subject:merge',
    ]);

    const boundary = { pool: kernelPool, deadline: Date.now() + 10_000 };
    await createSuspensionCommands({ pool: kernelPool, access, clock: options.clock ?? systemClock }).suspend(
      { ...boundary, actor: await access.authenticate(governor.bearer, boundary) },
      { accountId: accounts.suspended.accountId, key: randomUUID() },
    );

    if ((options.linkProjection ?? 'owned') === 'owned')
      relays = startRelays(runtimePool, [linkProjection(runtimePool)], { intervalMs: 25 });

    const driver: SemanticDriver = {
      globalContext: GLOBAL_CONTEXT,
      request(persona, method, path, body, headers) {
        if (persona === 'anonymous') return send(null, method, path, body, headers);
        return send(accounts[persona], method, path, body, headers, persona);
      },
      async compile(root, schemas, presentation) {
        const bundled = bundledSources();
        const mergedPresentation = { ...bundled.presentation };
        for (const [groupLocale, additions] of Object.entries(presentation)) {
          const base = Bun.YAML.parse(mergedPresentation[groupLocale] ?? '{}') as {
            types?: Record<string, string>;
            properties?: Record<string, string>;
          };
          mergedPresentation[groupLocale] = Bun.YAML.stringify({
            types: { ...(base.types ?? {}), ...(additions.types ?? {}) },
            properties: { ...(base.properties ?? {}), ...(additions.properties ?? {}) },
          });
        }
        const release = await compileCatalogue({
          root,
          schemas: { ...bundled.schemas, ...schemas },
          presentation: mergedPresentation,
          contexts: bundled.contexts,
          filters: bundled.filters,
        });
        return { digest: releaseDigest(release), release: release as unknown as Release };
      },
      async grant(persona, actions, resourceId) {
        if (persona === 'anonymous') throw new Error('Anonymous is not an account grant recipient');
        const target = resourceId ?? PLATFORM_RESOURCE.id;
        const grantor = target === GLOBAL_CONTEXT || target === PLATFORM_RESOURCE.id ? governor : editor;
        await grantAccount(accounts[persona], actions, resourceId, grantor);
      },
      async projection(state) {
        if ((options.linkProjection ?? 'owned') === 'external')
          throw new Error('Semantic helper projection control is unavailable when link projection is external');
        if (state === 'paused') await relays!.pause();
        else relays!.resume();
      },
      inspect: {
        async revisions(subjectId) {
          const route = routeOf(subjectId);
          if (route === null) return [];
          const rows = await pool!.query<{
            revision: number;
            partition: number;
            transaction_id: string;
          }>(
            `SELECT revision, route >> 4 AS partition,
                    recorded_transaction_id::text AS transaction_id
               FROM semantic.revision
              WHERE route=$1 AND subject_id=$2
              ORDER BY revision`,
            [route, subjectId],
          );
          return rows.rows.map((row) => ({
            revision: Number(row.revision),
            partition: Number(row.partition),
            transactionId: row.transaction_id,
          }));
        },
      },
      close: () => entry.close(),
    };
    timer.mark('rest');
    timer.report(number);
    return {
      ...driver,
      fixtures: {
        pool: pool!,
        async authenticatedAccount(account) {
          if (!credentials.has(account)) throw new Error('Expected an existing native fixture account');
          const actor = await access.authenticate(account.bearer, { pool: pool!, deadline: Date.now() + 10_000 });
          if (actor.kind !== 'account' || actor.accountId !== account.accountId)
            throw new Error('Native account authentication did not preserve fixture identity');
          return actor;
        },
        runtime: {
          databaseUrl: kernelUrl,
          routeKey: Buffer.from(routeKey).toString('base64url'),
          sessionKeys: [...sessionKeys.keys]
            .map(([id, key]) => `${id}:${Buffer.from(key).toString('base64url')}`)
            .join(','),
          authIssuer: required(runtimeAuth?.issuer, 'Kernel did not construct Access with the Auth issuer'),
          authAudience: required(runtimeAuth?.audience, 'Kernel did not construct Access with the Auth audience'),
          authJwksUrl: required(runtimeAuth?.jwksUrl, 'Kernel did not construct Access with the Auth JWKS URL'),
        },
        governorScopes: Object.freeze([...governanceScopes]),
        person,
        verifiedAutomated,
        signIn,
        scopeVariant,
        async openFeatures(groups) {
          if (completion) throw new Error('Semantic outcome fixture is closed');
          if (!Array.isArray(groups) || groups.some((group) => !releasedDiscoveryFeatures.includes(group)))
            throw new Error('Unknown released discovery feature');
          for (const group of new Set(groups)) {
            const response = await send(governor, 'POST', `/v1/platform/exposure/${group}:open`, undefined, {
              'Idempotency-Key': key(),
            });
            // Preserve the native status, problem and headers for missing policy/runtime prerequisites.
            if (response.status !== 200) throw response;
          }
        },
        grantAccount: (account, actions, resourceId) => grantAccount(account, actions, resourceId),
        handle: (request) => app.handle(request),
        send: (account, method, path, body, headers) => send(account, method, path, body, headers),
        governor,
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (options.strictCleanup)
        throw new AggregateError([error, cleanupError], 'Semantic outcome setup and cleanup failed', { cause: error });
    }
    throw error;
  }
}
