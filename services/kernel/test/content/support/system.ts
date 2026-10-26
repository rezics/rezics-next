import { createHash, randomBytes } from 'node:crypto';
import { WEBSITE_CLIENT_ID, type PublicJwks } from '@rezics/auth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool, type Pool as PgPool } from 'pg';
import type { Access, AccountActor, ActionCatalogue } from '../../../src/request/access.ts';
import type { Kernel } from '../../../src/http/kernel.ts';
import type { KeyRing } from '../../../src/tokens/seal.ts';
import { createNativeContentSystem } from './native-system.ts';

export type ContentAccountState = 'active' | 'suspended';

/** A credential and identity observed by the production Access verifier. */
export interface ContentCredential {
  readonly bearer: string;
  readonly actor: AccountActor;
}

export interface ContentActors {
  readonly anonymous: null;
  readonly author: ContentCredential;
  readonly other: ContentCredential;
  readonly moderator: ContentCredential;
  readonly suspended: ContentCredential;
  readonly worker: ContentCredential;
  readonly otherWorker: ContentCredential;
}

export interface ContentAuthClient {
  readonly id: string;
  readonly kind: 'first-party' | 'confidential';
}

export interface ContentSystemOptions {
  /** Migrated source database used as the template for an isolated fixture database. */
  readonly databaseUrl: string;
  /** Observe successfully created isolated database names, including partial construction. */
  readonly onDatabaseCreated?: (name: string) => void;
}

export interface ContentSystem {
  readonly database: {
    /** Isolated migrated application database used by Kernel and Access. */
    readonly pool: Pool;
    /** Administrative connection used only for fixture namespace lifecycle/setup. */
    readonly admin: Pool;
    /** Isolated migrated Auth database. */
    readonly authPool: Pool;
    /** Administrative connection for Auth database lifecycle/setup. */
    readonly authAdmin: Pool;
  };
  readonly kernel: Kernel;
  readonly routeKey: Uint8Array;
  readonly tokenKeys: KeyRing;
  readonly actors: ContentActors;
  readonly auth: {
    readonly ordinaryClient: ContentAuthClient;
    readonly websiteClient: ContentAuthClient;
    /** Obtain a real Auth-issued token for a provisioned account and registered client. */
    issue(input: {
      readonly accountId: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly requestedBy?: string;
    }): Promise<ContentCredential>;
    /** Refresh through the real Auth service while retaining the registered client identity. */
    refresh(input: { readonly refreshToken: string }): Promise<ContentCredential>;
  };
  readonly access: Access;
  /** Catalogue derived from the routes mounted on this real Kernel. */
  readonly actions: ActionCatalogue;
  readonly clock: {
    setCommandTime(instant: string): Promise<void>;
    setCursorVerificationTime(instant: string): Promise<void>;
  };
  readonly transport: {
    /** Route an exact Request through Kernel.handle and retain both wire objects. */
    capture(request: Request): Promise<{ readonly request: Request; readonly response: Response }>;
  };
  close(): Promise<void>;
}

type WebsiteTokenSet = {
  access_token: string;
  refresh_token: string;
};

const protocolScopes = ['openid', 'offline_access'];
const clientAssertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

function observeCreatedDatabases(templateUrl: string, onDatabaseCreated: (name: string) => void): () => void {
  const templateName = decodeURIComponent(new URL(templateUrl).pathname.slice(1));
  const prototype = Pool.prototype as unknown as { query: (this: PgPool, ...args: unknown[]) => unknown };
  const originalQuery = prototype.query;
  let namespace: string | undefined;
  const wrappedQuery = function (this: PgPool, ...args: unknown[]): unknown {
    const input = args[0];
    const sql =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && 'text' in input && typeof input.text === 'string'
          ? input.text
          : undefined;
    const create = sql?.match(
      /^\s*CREATE\s+DATABASE\s+("[^"]+"|[a-z0-9_]+)\s+TEMPLATE\s+("(?:[^"]|"")*"|[a-z0-9_]+)\s*;?\s*$/i,
    );
    const databaseName = create?.[1]?.startsWith('"') ? create[1].slice(1, -1).replaceAll('""', '"') : create?.[1];
    const sourceTemplate = create?.[2]?.startsWith('"') ? create[2].slice(1, -1).replaceAll('""', '"') : create?.[2];
    const fixtureApp = databaseName?.match(/^(content_[a-f0-9]{32})_app$/i);
    const fixtureAuth = databaseName?.match(/^(content_[a-f0-9]{32})_auth$/i);
    const isAppDatabase = sourceTemplate === templateName && fixtureApp !== undefined;
    const isAuthDatabase = namespace !== undefined && sourceTemplate === 'template0' && fixtureAuth?.[1] === namespace;
    const createdName = isAppDatabase ? databaseName : isAuthDatabase ? databaseName : undefined;
    const result = Reflect.apply(originalQuery, this, args);
    if (createdName === undefined) return result;
    return Promise.resolve(result).then((value) => {
      if (isAppDatabase) namespace = fixtureApp![1];
      onDatabaseCreated(createdName);
      return value;
    });
  };
  prototype.query = wrappedQuery;
  return () => {
    if (prototype.query === wrappedQuery) prototype.query = originalQuery;
  };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/** Compose the ordinary native fixture with Auth's confidential website flow.
 * The native fixture owns database lifecycle, account provisioning, governance,
 * Access, Kernel, clocks and transport; this layer only registers and uses the
 * real `rezics-website` client against those same services.
 */
export async function createContentSystem(options: ContentSystemOptions): Promise<ContentSystem> {
  const restoreDatabaseObserver = options.onDatabaseCreated
    ? observeCreatedDatabases(options.databaseUrl, options.onDatabaseCreated)
    : undefined;
  let native: Awaited<ReturnType<typeof createNativeContentSystem>>;
  try {
    native = await createNativeContentSystem(options);
  } finally {
    restoreDatabaseObserver?.();
  }
  try {
    const issuer = native.nativeAuth.verifier.issuer;
    const audience = native.nativeAuth.verifier.audience;
    const callback = `${issuer}/content-fixture/callback`;
    const websiteKeyPair = await generateKeyPair('ES256', { extractable: true });
    const websiteKeyId = `content-${crypto.randomUUID()}`;
    const publicKey = await exportJWK(websiteKeyPair.publicKey);
    const websiteScopes = [...new Set([...protocolScopes, ...native.actions.keys()])].sort();

    // Auth's website registration is the only path that can install this
    // confidential client or authorize media:complete.
    await native.nativeAuth.internal.registerWebsiteClient({
      publicJwks: {
        keys: [{ ...publicKey, kid: websiteKeyId, alg: 'ES256', use: 'sig' }],
      } as PublicJwks,
      redirectUris: [callback],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: websiteScopes,
    });
    const websiteClient = { id: WEBSITE_CLIENT_ID, kind: 'confidential' as const };
    const allowedWebsiteScopes = new Set(websiteScopes);

    // The native fixture's public credential helper signs in with each
    // provisioned account's real password. Observe that response's real Auth
    // session cookie so /authorize can run its browser-session and PKCE flow.
    const nativeHandler = native.nativeAuth.handler.bind(native.nativeAuth);
    let lastLoginCookie: string | undefined;
    native.nativeAuth.handler = async (request) => {
      const response = await nativeHandler(request);
      if (new URL(request.url).pathname === '/signin' && request.method === 'POST' && response.ok) {
        const cookie = cookieHeader(response);
        if (!cookie) throw new Error('Native Auth sign-in did not return its session cookie');
        lastLoginCookie = cookie;
      }
      return response;
    };

    const assertion = async (): Promise<string> => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: websiteKeyId })
        .setIssuer(websiteClient.id)
        .setSubject(websiteClient.id)
        .setAudience(issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + 120)
        .setJti(randomBytes(24).toString('base64url'))
        .sign(websiteKeyPair.privateKey);
    };

    const tokenRequest = async (fields: Record<string, string>): Promise<WebsiteTokenSet> => {
      const form = new URLSearchParams({
        client_id: websiteClient.id,
        client_assertion_type: clientAssertionType,
        client_assertion: await assertion(),
        resource: audience,
        ...fields,
      });
      const response = await native.nativeAuth.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        }),
      );
      if (!response.ok)
        throw new Error(`Website Auth token request denied (${response.status}): ${await response.text()}`);
      const tokens = (await response.json()) as Partial<WebsiteTokenSet>;
      if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string')
        throw new Error('Website Auth did not return access and refresh tokens');
      return tokens as WebsiteTokenSet;
    };

    const credential = async (bearer: string): Promise<ContentCredential> => {
      const actor = await native.access.authenticate(bearer, {
        pool: native.database.pool,
        deadline: Date.now() + 10000,
      });
      if (actor.kind !== 'account') throw new Error('Native Auth did not authenticate an account');
      return { bearer, actor };
    };

    const refreshWebsite = async (refreshToken: string): Promise<ContentCredential> => {
      const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
      return credential(tokens.access_token);
    };

    const issueWebsite = async (input: {
      accountId: string;
      scopes: readonly string[];
      requestedBy?: string;
    }): Promise<ContentCredential> => {
      if (input.requestedBy !== undefined) throw new TypeError('Website OAuth credentials do not carry requestedBy');
      const requested = [...new Set(input.scopes)].sort();
      if (requested.some((scope) => !allowedWebsiteScopes.has(scope)))
        throw new TypeError('Website OAuth scopes must be registered protocol scopes or mounted kernel actions');

      lastLoginCookie = undefined;
      // This is a real first-party sign-in through the native fixture helper;
      // it supplies only the browser session needed for website authorization.
      const ordinary = await native.auth.issue({
        accountId: input.accountId,
        clientId: native.auth.ordinaryClient.id,
        scopes: native.actors.author.actor.scopes,
      });
      if (ordinary.actor.accountId !== input.accountId || !lastLoginCookie)
        throw new Error('Native Auth could not establish the requested website account session');
      const cookie = lastLoginCookie;
      lastLoginCookie = undefined;

      const verifier = randomBytes(48).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      const scopes = [...new Set([...protocolScopes, ...requested])].sort();
      const authorize = new URL(`${issuer}/authorize`);
      authorize.search = new URLSearchParams({
        client_id: websiteClient.id,
        redirect_uri: callback,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        nonce: state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: audience,
      }).toString();
      const authorization = await native.nativeAuth.handler(new Request(authorize, { headers: { cookie } }));
      if (![302, 303].includes(authorization.status))
        throw new Error(`Website Auth authorization denied (${authorization.status}): ${await authorization.text()}`);
      const location = new URL(authorization.headers.get('location') ?? '');
      if (`${location.origin}${location.pathname}` !== callback || location.searchParams.get('state') !== state)
        throw new Error('Website Auth returned an invalid authorization redirect');
      const code = location.searchParams.get('code');
      if (!code) throw new Error('Website Auth did not return an authorization code');

      const issued = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      });
      // Exercise real refresh-token rotation while the bearer and its refresh
      // family are still entirely inside fixture setup.
      const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
      return credential(rotated.access_token);
    };

    const issue: ContentSystem['auth']['issue'] = async (input) => {
      if (input.clientId === websiteClient.id)
        return issueWebsite({
          accountId: input.accountId,
          scopes: input.scopes,
          ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
        });
      return native.auth.issue(input);
    };

    const refresh: ContentSystem['auth']['refresh'] = async ({ refreshToken }) => {
      // The native first-party helper accepts its real session cookie, while
      // the confidential website client accepts its opaque rotating token.
      if (refreshToken.includes('=')) return native.auth.refresh({ refreshToken });
      return refreshWebsite(refreshToken);
    };

    const worker = await issueWebsite({
      accountId: native.actors.author.actor.accountId,
      scopes: [...native.actions.keys()],
    });
    const otherWorker = await issueWebsite({
      accountId: native.actors.other.actor.accountId,
      scopes: [...native.actions.keys()],
    });

    return {
      database: native.database,
      kernel: native.kernel,
      routeKey: native.routeKey,
      tokenKeys: native.tokenKeys,
      actors: { ...native.actors, worker, otherWorker },
      auth: { ordinaryClient: native.auth.ordinaryClient, websiteClient, issue, refresh },
      access: native.access,
      actions: native.actions,
      clock: native.clock,
      transport: native.transport,
      close: native.close,
    };
  } catch (error) {
    try {
      await native.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Content fixture construction and cleanup failed');
    }
    throw error;
  }
}
