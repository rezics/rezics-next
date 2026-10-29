import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
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
  const authPool = new Pool({ connectionString: connection(authName) });
  // Auth owns this pool once constructed, including failure during construction.
  // Share its one close operation with the partial-construction cleanup below.
  const endAuthPool = authPool.end.bind(authPool);
  let authEnding: Promise<void> | undefined;
  authPool.end = () => (authEnding ??= endAuthPool());
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
      await release(() => authPool.end());
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
    // Kernel resolves Access on a live request, after all routes are mounted.
    // This same instance authenticates fixture credentials on this exact pool.
    const kernel = createKernel({
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
    const actions = actionCatalogue(kernel);
    let realmMembership: ReturnType<typeof createRealmMembership> | undefined;
    const access = createAccess({
      actions,
      clock,
      realmRoleReader: (client, input) => {
        realmMembership ??= createRealmMembership({ pool, access, clock });
        return realmMembership.roleReader(client, input);
      },
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: (input, init) => nativeAuth.handler(new Request(input, init)),
      },
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
          actions,
          referenceKeys,
          creationBinding: (input) => proofs.creationBinding(input),
        });
        return {
          context: () => ({ pool, deadline: Date.now() + 10000 }),
          approve: (token, input, context) => approvals.approve(token, input as never, context as never),
          resolveForCaller: (token, reference, operation, context) =>
            approvals.resolveForCaller(token, reference, operation as never, context as never),
          admitGroup: async () => false,
        };
      })(),
      stagingKey: crypto.getRandomValues(new Uint8Array(32)),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: namespace,
    });
    nativeAuth = host.service;
    const ordinaryClient = { id: `${namespace}_ordinary`, kind: 'first-party' as const };
    const scopes = [...actions.keys()].filter((action) => action !== 'media:complete').sort();
    await nativeAuth.internal.registerClient({ clientId: ordinaryClient.id, firstParty: true, scopes });
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
    const password = crypto.randomUUID() + crypto.randomUUID();
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
      return issue({ accountId, clientId: ordinaryClient.id, scopes });
    };
    const governance = await person('governance');
    await bootstrapGovernance(pool, governance.actor.accountId);
    const author = await person('author');
    const other = await person('other');
    const moderator = await person('content-moderator');
    const suspended = await person('suspended');
    const capture = async (request: Request) => ({ request, response: await kernel.handle(request) });
    const command = async (path: string, body: unknown, status: number) => {
      const request = new Request(`${audience}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${governance.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      });
      await assertSetupResponse(await kernel.handle(request), request, status);
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

    return {
      database: { pool, admin, authPool, authAdmin },
      kernel,
      routeKey,
      tokenKeys,
      actors: { anonymous: null, author, other, moderator, suspended },
      auth: {
        ordinaryClient,
        issue,
        // Ordinary Auth renews access via its signed native session cookie,
        // rather than the website-only OAuth refresh protocol. Pass that real
        // cookie unchanged; Auth rechecks session, state, client and scopes.
        refresh: async ({ refreshToken }) => credential(await requestAuth('/token', {}, refreshToken)),
      },
      nativeAuth,
      deletion: {
        auth: {
          authPool,
          host,
          request: (path, body, headers) => requestAuth(path, body, headers?.get('cookie') ?? ''),
        },
        async person() {
          const name = `erase_${crypto.randomUUID().replaceAll('-', '')}`;
          const { accountId } = await host!.workflows.register({
            key: name,
            handle: name,
            email: `${name}@content.test`,
            password: 'ordinary native registration password',
          });
          const signed = await requestAuth('/signin', {
            account_id: accountId,
            password: 'ordinary native registration password',
            client_id: ordinaryClient.id,
            scope: scopes,
          });
          const cookie = signed.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; ');
          const token = await credential(await requestAuth('/token', {}, cookie));
          return { accountId, bearer: token.bearer };
        },
      },
      access,
      actions,
      clock: { setCommandTime: setTime, setCursorVerificationTime: setTime },
      transport: { capture },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native content construction and cleanup failed');
    }
    throw error;
  }
}
