import { configureTestReceiptKeys, testReceiptKeys } from '../../support/receipt-keys.ts';
import { registerAccountDeletionRuntime, type AccountDeletionRuntime } from '../../support/account-deletion.ts';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  WEBSITE_CLIENT_ID,
  type PublicJwks,
  type AuthService,
  type AccountOperationAccess,
} from '@rezics/auth';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createWorkflowApprovals } from '../../../src/access/workflow-approvals.ts';
import { createAccess } from '../../../src/access/index.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createNativeAccountBindings } from '../../../src/access/native-account-bindings.ts';
import { LIFECYCLE_ACTIONS } from '../../../src/access/lifecycle.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createRealmMembership } from '../../../src/community/membership.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { accessCheck } from '../../../src/request/access.ts';
import { createAuthDatabase } from '../../support/auth-database.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { assertSetupResponse } from './setup-response.ts';
import type { ContentActors, ContentCredential, ContentSystem, ContentSystemOptions } from './system.ts';

export type NativeContentSystem = Omit<ContentSystem, 'actors' | 'auth'> & {
  readonly actors: Omit<ContentActors, 'worker' | 'otherWorker'>;
  readonly auth: Omit<ContentSystem['auth'], 'websiteClient'>;
  /** The full fixture registers its website client on this same real Auth service. */
  readonly nativeAuth: AuthService;
};

type NativeRegistration = { key: string; handle: string; email: string; password: string };
const nativeRegistrations = new WeakMap<
  NativeContentSystem,
  (input: NativeRegistration) => Promise<{ accountId: string }>
>();

/** Register a test persona through the ordinary native Auth workflow. */
export async function registerNativeContentAccount(
  system: NativeContentSystem,
  input: NativeRegistration,
): Promise<{ accountId: string }> {
  const register = nativeRegistrations.get(system);
  if (!register) throw new TypeError('Native content system has no account registration workflow');
  return register(input);
}

export class NativeContentSystemUnfinishedError extends Error {
  constructor() {
    super('Native content system is unfinished; actual native composition is required');
    this.name = 'NativeContentSystemUnfinishedError';
  }
}

/** Private ordinary identity composition. Namespace cloning and fixed native
 * provisioning precede measured API work; they make no runtime growth claim.
 * All account state and permission outcomes belong to the shared native APIs.
 * The full fixture registers its genuine website client on nativeAuth later.
 */
export function createNativeContentSystem(options: ContentSystemOptions): Promise<NativeContentSystem> {
  return createNativeContentSystemWithWriteRateOverrides(options, '{}');
}

/** Request suite-specific ordinary scopes through Auth, preserving default fixture credentials. */
export function createNativeContentSystemWithOrdinaryScopes(
  options: ContentSystemOptions,
  ordinaryScopes?: readonly string[],
): Promise<NativeContentSystem> {
  return createNativeContentSystemWithOptions(options, '{}', ordinaryScopes);
}

/** Build a native system with a suite-specific limiter budget while preserving the public fixture options shape. */
export function createNativeContentSystemWithWriteRateOverrides(
  options: ContentSystemOptions,
  writeRateOverrides: string,
): Promise<NativeContentSystem> {
  return createNativeContentSystemWithOptions(options, writeRateOverrides);
}

async function createNativeContentSystemWithOptions(
  options: ContentSystemOptions,
  writeRateOverrides: string,
  ordinaryScopes?: readonly string[],
): Promise<NativeContentSystem> {
  const source = new URL(options.databaseUrl);
  const template = decodeURIComponent(source.pathname.slice(1));
  if (!template) throw new Error('A migrated application template database is required');
  const namespace = options.namespace ?? `content_${crypto.randomUUID().replaceAll('-', '')}`;
  const appName = `${namespace}_app`;
  const authName = `${namespace}_auth`;
  const connection = (name: string) => {
    const url = new URL(source);
    url.pathname = `/${name}`;
    return url.href;
  };
  const admin = new Pool({ connectionString: connection('postgres') });
  const authAdmin = new Pool({ connectionString: connection('postgres') });
  const pool = new Pool({ connectionString: connection(appName) });
  configureTestReceiptKeys(pool);
  let closeAuthPool: (() => Promise<void>) | undefined;
  let appCreated = false;
  let authCreated = false;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      const release = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      if (host) await release(() => host!.stop());
      if (closeAuthPool) await release(closeAuthPool);
      await release(() => pool.end());
      // Only these randomly named databases were created by this invocation.
      // Do not terminate sessions or remove any caller-owned namespace.
      if (authCreated) await release(() => dropTestDatabase(authAdmin, authName));
      if (appCreated) await release(() => admin.query(`DROP DATABASE ${appName}`));
      await release(() => authAdmin.end());
      await release(() => admin.end());
      if (errors.length) throw new AggregateError(errors, 'Native content cleanup failed');
    })());

  try {
    // Inspect the source before cloning: an unmigrated caller database may have
    // live sessions, and is never ours to disconnect or migrate in place.
    const check = new Pool({ connectionString: source.href });
    try {
      const result = await check.query("SELECT to_regclass('access.account') AS account");
      if (!result.rows[0]?.account) throw new Error('Application template lacks account migrations');
    } finally {
      await check.end();
    }
    const quotedTemplate = `"${template.replaceAll('"', '""')}"`;
    await admin.query(`CREATE DATABASE ${appName} TEMPLATE ${quotedTemplate}`);
    appCreated = true;
    await createAuthDatabase(source.href, authName);
    authCreated = true;
    const authPoolOwner = options.authPoolFactory
      ? await options.authPoolFactory(connection(authName))
      : (() => {
          const authPool = new Pool({ connectionString: connection(authName) });
          return { pool: authPool, close: () => authPool.end() };
        })();
    const authPool = authPoolOwner.pool;
    // AuthHost owns this pool after handoff, including failed construction.
    // The fixture still releases its owner on partial setup and final cleanup.
    // Both paths must share the same physical close, preserving the setup error.
    const endAuthPool = authPool.end.bind(authPool);
    let poolEnding: Promise<void> | undefined;
    authPool.end = () => (poolEnding ??= endAuthPool());
    let authEnding: Promise<void> | undefined;
    closeAuthPool = () => (authEnding ??= authPoolOwner.close());

    const issuer = `https://${namespace.replaceAll('_', '-')}.auth.test`;
    const audience = 'https://content.test';
    const routeKey = crypto.getRandomValues(new Uint8Array(32));
    const tokenKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    const referenceKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    let instant: number | undefined;
    const clock = () => new Date(instant ?? Date.now());
    const setTime = async (value: string) => {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) throw new TypeError('Invalid trusted command time');
      instant = parsed;
    };
    let nativeAuth: AuthService;
    let access: ReturnType<typeof createAccess>;
    let actions: ReturnType<typeof actionCatalogue>;
    const createFreshAccess: ContentSystem['createFreshAccess'] = (observeJwks) => {
      let fresh: ReturnType<typeof createAccess>;
      let realmMembership: ReturnType<typeof createRealmMembership> | undefined;
      fresh = createAccess({
        actions,
        clock,
        realmRoleReader: (client, input) => {
          realmMembership ??= createRealmMembership({ pool, access: fresh, clock });
          return realmMembership.roleReader(client, input);
        },
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const response = await nativeAuth.handler(request);
            await observeJwks?.(request, response.clone());
            return response;
          },
        },
      });
      return fresh;
    };
    // Kernel resolves Access on a live request, after all routes are mounted.
    // This same instance authenticates fixture credentials on this exact pool.
    const kernel = createKernel({
      receiptKeys: testReceiptKeys(),
      pool,
      routeKey,
      tokens: tokenKeys,
      clock,
      content: { cursorNow: () => clock().getTime() },
      access: () => access,
      writeRate: createWriteRateLimiter({
        secret: crypto.randomUUID() + crypto.randomUUID(),
        overrides: writeRateOverrides,
      }),
      ratePeer: () => '127.0.0.1',
    });
    actions = actionCatalogue(kernel);
    access = createFreshAccess();
    const createKernelForPool: ContentSystem['createKernelForPool'] = (targetPool, targetAccess) =>
      createKernel({
        receiptKeys: testReceiptKeys(),
        pool: targetPool,
        routeKey,
        tokens: tokenKeys,
        clock,
        content: { cursorNow: () => clock().getTime() },
        access: () => targetAccess,
        writeRate: createWriteRateLimiter({
          secret: crypto.randomUUID() + crypto.randomUUID(),
          overrides: writeRateOverrides,
        }),
        ratePeer: () => '127.0.0.1',
      });
    const proofs = createNativeWorkflowProofPorts({ database: authPool });
    const bindings = createNativeAccountBindings({
      pool,
      access,
      // Native operator commands are deliberately private application ports.
      // Their construction requires their internal management declaration. This
      // is not installed in HTTP Access, the returned catalogue or client scopes;
      // ordinary registration does not acquire operator authority from it.
      actions: new Map([...LIFECYCLE_ACTIONS, ['account:manage', { anonymous: false }], ...actions]),
      routeKey,
      clock,
      referenceKeys,
      auth: () => nativeAuth,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
        barriers: createBarrierProofVerifier({ database: authPool }),
      },
    });
    const pair = await generateKeyPair('ES256', { extractable: true });
    const privateKey = { ...(await exportJWK(pair.privateKey)), kid: namespace };
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: crypto.randomUUID() + crypto.randomUUID(),
      signing: { activeKid: privateKey.kid, privateKeys: [privateKey] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      accountOperations: (() => {
        const approvals = createWorkflowApprovals({
          pool,
          access,
          actions: new Map([...LIFECYCLE_ACTIONS, ...actions]),
          referenceKeys,
          creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
        });
        const ports: AccountOperationAccess = {
          context: () => ({ pool, deadline: Date.now() + 10000 }),
          approve: (token, input, context) => approvals.approve(token, input as never, context as never),
          resolveForCaller: (token, reference, operation, context) =>
            approvals.resolveForCaller(token, reference, operation as never, context as never),
          admitGroup: async () => false,
        };
        return ports;
      })(),
      stagingKey: crypto.getRandomValues(new Uint8Array(32)),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: namespace,
    });
    nativeAuth = host.service;
    const ordinaryClient = { id: `${namespace}_ordinary`, kind: 'first-party' as const };
    // Auth validates both the issued consent and the registered client ceiling
    // when a durable step restores its initiator.
    const ordinaryScopeList = ordinaryScopes
      ? [...ordinaryScopes]
      : [...new Set([...actions.keys(), ...LIFECYCLE_ACTIONS.keys()])]
          .filter((action) => action !== 'media:complete')
          .sort();
    await nativeAuth.internal.registerClient({
      clientId: ordinaryClient.id,
      firstParty: true,
      scopes: ordinaryScopeList,
    });
    const registeredOrdinaryScopes = Object.freeze(ordinaryScopeList);
    const websiteKeyPair = await generateKeyPair('ES256', { extractable: true });
    const websiteKeyId = `${namespace}_website`;
    const websiteCallback = `${issuer}/native-content/callback`;
    const websiteScopes = [...new Set(['openid', 'offline_access', ...actions.keys()])].sort();
    await nativeAuth.internal.registerWebsiteClient({
      publicJwks: {
        keys: [{ ...(await exportJWK(websiteKeyPair.publicKey)), kid: websiteKeyId, alg: 'ES256', use: 'sig' }],
      } as PublicJwks,
      redirectUris: [websiteCallback],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: websiteScopes,
    });
    await host.start();

    const requestAuth = async (path: string, body: unknown, cookie = '') => {
      const request = new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: {
          origin: issuer,
          'content-type': 'application/json',
          cookie,
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      });
      return assertSetupResponse(await nativeAuth.handler(request), request);
    };
    const credential = async (response: Response): Promise<ContentCredential> => {
      const { access_token: bearer } = (await response.json()) as { access_token: string };
      const actor = await access.authenticate(bearer, { pool, deadline: Date.now() + 10000 });
      if (actor.kind !== 'account') throw new Error('Native Auth did not authenticate an account');
      return { bearer, actor };
    };
    const websiteAssertion = async (): Promise<string> => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: websiteKeyId })
        .setIssuer(WEBSITE_CLIENT_ID)
        .setSubject(WEBSITE_CLIENT_ID)
        .setAudience(issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + 120)
        .setJti(randomBytes(24).toString('base64url'))
        .sign(websiteKeyPair.privateKey);
    };
    const websiteTokenRequest = async (fields: Record<string, string>) => {
      const form = new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await websiteAssertion(),
        resource: audience,
        ...fields,
      });
      const response = await nativeAuth.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        }),
      );
      if (!response.ok)
        throw new Error(`Website Auth token request denied (${response.status}): ${await response.text()}`);
      return (await response.json()) as { access_token: string; refresh_token: string };
    };
    const issueWebsite = async (input: { accountId: string; password: string; scopes: readonly string[] }) => {
      const requested = [...new Set(input.scopes)].sort();
      if (requested.some((scope) => !websiteScopes.includes(scope)))
        throw new TypeError('Website OAuth scopes must be registered protocol scopes or mounted kernel actions');
      const signed = await requestAuth(
        '/signin',
        {
          account_id: input.accountId,
          password: input.password,
          client_id: ordinaryClient.id,
          scope: registeredOrdinaryScopes,
        },
        '',
      );
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const verifier = randomBytes(48).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      const authorize = new URL(`${issuer}/authorize`);
      authorize.search = new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        redirect_uri: websiteCallback,
        response_type: 'code',
        scope: [...new Set(['openid', 'offline_access', ...requested])].sort().join(' '),
        state,
        nonce: state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: audience,
      }).toString();
      const authorization = await nativeAuth.handler(new Request(authorize, { headers: { cookie } }));
      if (![302, 303].includes(authorization.status))
        throw new Error(`Website Auth authorization denied (${authorization.status}): ${await authorization.text()}`);
      const location = new URL(authorization.headers.get('location') ?? '');
      if (`${location.origin}${location.pathname}` !== websiteCallback || location.searchParams.get('state') !== state)
        throw new Error('Website Auth returned an invalid authorization redirect');
      const code = location.searchParams.get('code');
      if (!code) throw new Error('Website Auth did not return an authorization code');
      const tokens = await websiteTokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: websiteCallback,
        code_verifier: verifier,
      });
      return credential(new Response(JSON.stringify({ access_token: tokens.access_token }), { status: 200 }));
    };
    const password = 'ordinary native registration password';
    const issue = async (input: Parameters<NativeContentSystem['auth']['issue']>[0]): Promise<ContentCredential> => {
      // Auth checks current identity, registered client and consent itself. The
      // supplied delegation reference is resolved by its native assignment reader.
      const signed = await requestAuth(
        '/signin',
        {
          account_id: input.accountId,
          password,
          client_id: input.clientId,
          scope: input.scopes,
        },
        '',
      );
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      return credential(
        await requestAuth('/token', input.requestedBy === undefined ? {} : { requested_by: input.requestedBy }, cookie),
      );
    };
    const person = async (name: string) => {
      const { accountId } = await host!.workflows.register({
        key: name,
        handle: name,
        email: `${name}@content.test`,
        password,
      });
      return issue({ accountId, clientId: ordinaryClient.id, scopes: registeredOrdinaryScopes });
    };
    const governance = await person('governance');
    await bootstrapGovernance(pool, governance.actor.accountId);
    // Fixture provisioning uses its own native client, independent of the suite's
    // ordinary scope ceiling. Bootstrap installs grants, never client consent.
    const grantorClientId = `${namespace}_grantor`;
    const grantorScopes = ['access:grant', 'space:create', 'realm:create', 'subject:create', 'account:suspend'];
    await nativeAuth.internal.registerClient({ clientId: grantorClientId, firstParty: true, scopes: grantorScopes });
    const grantor = await issue({
      accountId: governance.actor.accountId,
      clientId: grantorClientId,
      scopes: grantorScopes,
    });
    const [author, other, moderator, suspended] = await Promise.all([
      person('author'),
      person('other'),
      person('content-moderator'),
      person('suspended'),
    ]);
    const capture = async (request: Request) => ({ request, response: await kernel.handle(request) });
    const command = async (path: string, body: unknown, status: number) => {
      const request = new Request(`${audience}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${grantor.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      });
      const response = await kernel.handle(request);
      if (response.status === 403) {
        const context = { pool, deadline: Date.now() + 10_000 };
        const actor = await access.authenticate(grantor.bearer, context);
        const authority = [];
        for (const action of grantorScopes) {
          const check = await accessCheck(access, actor, action, PLATFORM_RESOURCE, context);
          authority.push({ action, allowed: await check(pool) });
        }
        throw new Error(
          `Native setup ${path} denied: ${await response.text()}; current grantor authority ${JSON.stringify(authority)}`,
        );
      }
      await assertSetupResponse(response, request, status);
    };
    // Parent creation permissions only. Product resource ownership/standing
    // remains the responsibility of each real creation command.
    for (const actor of [author, other, moderator, suspended]) {
      await command(
        '/v1/grants',
        {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: actor.actor.accountId },
          actions: ['space:create', 'realm:create', 'subject:create'],
          valid: '(,)',
        },
        201,
      );
    }
    await command(`/v1/accounts/${suspended.actor.accountId}:suspend`, { reason: 'Native suspended persona' }, 200);

    const deletion: AccountDeletionRuntime = {
      auth: {
        authPool,
        host,
        request: (path, body, headers) => requestAuth(path, body, headers?.get('cookie') ?? ''),
      },
      async person() {
        const name = `erase_${crypto.randomUUID().replaceAll('-', '')}`;
        const clientId = `${name}_client`;
        const deletionScopes = [...new Set([...registeredOrdinaryScopes, 'account:delete'])];
        const personPassword = 'ordinary native registration password';
        await nativeAuth.internal.registerClient({ clientId, firstParty: true, scopes: deletionScopes });
        const { accountId } = await host!.workflows.register({
          key: name,
          handle: name,
          email: `${name}@content.test`,
          password: personPassword,
        });
        const signed = await requestAuth('/signin', {
          account_id: accountId,
          password: personPassword,
          client_id: clientId,
          scope: deletionScopes,
        });
        const cookie = signed.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const token = await credential(await requestAuth('/token', {}, cookie));
        const website = await issueWebsite({
          accountId,
          password: personPassword,
          scopes: ['media:create', 'media:complete', 'media:read_reservation', 'media:erase', 'realm:participate'],
        });
        return { accountId, bearer: token.bearer, websiteBearer: website.bearer };
      },
    };
    const system: NativeContentSystem = {
      database: { pool, admin, authPool, authAdmin },
      kernel,
      routeKey,
      tokenKeys,
      actors: { anonymous: null, author, other, moderator, suspended },
      auth: {
        ordinaryClient,
        ordinaryScopes: registeredOrdinaryScopes,
        issue,
        // Ordinary Auth renews access via its signed native session cookie,
        // rather than the website-only OAuth refresh protocol. Pass that real
        // cookie unchanged; Auth rechecks session, state, client and scopes.
        refresh: async ({ refreshToken }) => credential(await requestAuth('/token', {}, refreshToken)),
      },
      nativeAuth,
      access,
      createFreshAccess,
      createKernelForPool,
      actions,
      clock: { setCommandTime: setTime, setCursorVerificationTime: setTime },
      transport: { capture },
      close,
    };
    nativeRegistrations.set(system, (input) => host!.workflows.register(input));
    registerAccountDeletionRuntime(system, deletion);
    return system;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native content construction and cleanup failed');
    }
    throw error;
  }
}
