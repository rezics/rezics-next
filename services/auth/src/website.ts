import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { compactVerify, createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { Pool } from 'pg';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { AuthServiceOptions, PublicJwks, SessionProof, WebsiteClientRegistration } from './index.ts';
import { publicCredential } from './key-credentials.ts';
import { issuerOrigin } from './issuer.ts';

export const WEBSITE_CLIENT_ID = 'rezics-website';
const protocolScopes = ['openid', 'offline_access'];
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
type RefusalCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target';
class ProtocolRefused extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}
function deny(code: RefusalCode): never {
  throw new ProtocolRefused(code);
}
const authorizationParameters = new Set([
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'prompt',
  'max_age',
]);
function asksForLogin(prompt: string | null) {
  return (prompt ?? '').split(' ').includes('login');
}
/** OIDC max_age is the elapsed seconds since auth_time. Zero is never fresh. */
function authenticationIsStale(authTime: number, maxAge: string | null) {
  if (maxAge === null || !/^(0|[1-9]\d*)$/.test(maxAge)) return false;
  const seconds = Number(maxAge);
  if (!Number.isSafeInteger(seconds)) return false;
  if (seconds === 0) return true;
  return Math.floor(Date.now() / 1000) - authTime > seconds;
}
/** Keep the provider's signed query bytes. Re-encoding would change the signature. */
function stepUpLocation(location: string, issuer: string) {
  const login = '/login';
  const absolute = `${issuer}${login}`;
  if (location === absolute || location.startsWith(`${absolute}?`)) return `/step-up${location.slice(absolute.length)}`;
  if (location === login || location.startsWith(`${login}?`)) return `/step-up${location.slice(login.length)}`;
  return undefined;
}
function invalidJwt(error: unknown) {
  return (
    error instanceof errors.JOSEError &&
    !(error instanceof errors.JWKInvalid) &&
    !(error instanceof errors.JWKSInvalid) &&
    !(error instanceof errors.JWKSMultipleMatchingKeys) &&
    !(error instanceof errors.JWKSTimeout)
  );
}
function failure(code: RefusalCode | 'temporarily_unavailable') {
  return Response.json(
    { error: code },
    {
      status: code === 'temporarily_unavailable' ? 503 : code === 'invalid_client' ? 401 : 400,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
async function protocolResponse(run: () => Promise<Response>, token: boolean) {
  try {
    const response = await run();
    if (response.status >= 500) return failure('temporarily_unavailable');
    if (response.status >= 400) {
      if (!token) return failure('invalid_request');
      const { error } = await response.json();
      switch (error) {
        case 'invalid_request':
        case 'invalid_client':
        case 'invalid_grant':
        case 'unsupported_grant_type':
        case 'invalid_scope':
        case 'invalid_target':
          return failure(error);
        default:
          return failure('temporarily_unavailable');
      }
    }
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return failure(
      error instanceof ProtocolRefused ? (token ? error.code : 'invalid_request') : 'temporarily_unavailable',
    );
  }
}

type Session = {
  id: string;
  userId: string;
  clientId: string;
  grantedScope: string;
  authnEpoch: number;
  authTime: number;
  authMethods: string;
  expiresAt: Date;
};
type Client = { scopes: string[]; jwks: string; redirectUris: string[]; postLogoutRedirectUris: string[] };
interface NativePort {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: {
      headers: Headers;
      query: { disableCookieCache: true; disableRefresh: true };
    }): Promise<{ session: Session } | null>;
  };
}
export function websiteRoutes(input: {
  options: AuthServiceOptions;
  scopeLimit: number;
  database: Pool;
  native: () => NativePort;
  withIssuance<T>(clientId: string, run: () => Promise<T>): Promise<T>;
  sessionProof(headers: Headers): Promise<SessionProof>;
  getJwks(): Promise<PublicJwks>;
}) {
  const { options, database } = input;
  const issuance = new AsyncLocalStorage<{ session: Session; scopes: string[] }>();
  const assertionAdmission = new AsyncLocalStorage<() => Promise<void>>();
  const logoutAdmission = new AsyncLocalStorage<boolean>();
  async function client(): Promise<Client> {
    const row = (
      await database.query<Client>(
        `SELECT scopes,jwks,"redirectUris","postLogoutRedirectUris"
      FROM auth_client WHERE client_id=$1 AND first_party AND "tokenEndpointAuthMethod"='private_key_jwt'
      AND NOT EXISTS (SELECT 1 FROM auth_client_reduction WHERE client_id=$1)`,
        [WEBSITE_CLIENT_ID],
      )
    ).rows[0];
    return row ?? deny('invalid_client');
  }
  async function proof(session: Session, scopes: string[], initialAuthorization = false) {
    const account = await options.trustedAccess.readAccount(session.userId);
    if (
      !account ||
      account.accountId !== session.userId ||
      account.kind !== 'actor' ||
      account.state !== 'active' ||
      account.automated ||
      account.fenced ||
      !Number.isSafeInteger(account.authnEpoch) ||
      session.authnEpoch !== account.authnEpoch ||
      session.expiresAt <= new Date() ||
      !Number.isSafeInteger(session.authTime) ||
      session.authTime > Math.floor(Date.now() / 1000) ||
      !['pwd', 'pop'].includes(session.authMethods)
    )
      deny('invalid_grant');
    const registered = await client();
    if (scopes.some((scope) => !registered.scopes.includes(scope))) deny('invalid_scope');
    // The existing first-party consent projection is also the reduction index.
    // Its current contents never supply resource or principal grants.
    const consent = (
      await database.query<{ scopes: string[] }>(
        'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
        [session.userId, WEBSITE_CLIENT_ID],
      )
    ).rows[0];
    if ((!consent && !initialAuthorization) || (consent && scopes.some((scope) => !consent.scopes.includes(scope))))
      deny('invalid_grant');
    return session;
  }
  /** Issuance hooks run inside the native token endpoint. A concurrent Access
   * invalidation or revocation is a refused grant there, never a server error. */
  async function recheck(session: Session, scopes: string[]) {
    try {
      await proof(session, scopes);
    } catch (error) {
      if (error instanceof ProtocolRefused)
        throw new APIError(error.code === 'invalid_client' ? 'UNAUTHORIZED' : 'BAD_REQUEST', { error: error.code });
      throw error;
    }
  }
  async function nativeSession(id: string): Promise<Session> {
    return (await database.query<Session>('SELECT * FROM session WHERE id=$1', [id])).rows[0] ?? deny('invalid_grant');
  }
  async function assertion(fields: URLSearchParams) {
    if (
      fields.get('client_id') !== WEBSITE_CLIENT_ID ||
      fields.get('client_assertion_type') !== assertionType ||
      fields.has('client_secret')
    )
      deny('invalid_client');
    const value = fields.get('client_assertion') ?? deny('invalid_client');
    const keys: PublicJwks = JSON.parse((await client()).jwks);
    let header;
    try {
      header = decodeProtectedHeader(value);
    } catch {
      deny('invalid_client');
    }
    try {
      if (
        header.alg !== 'ES256' ||
        typeof header.kid !== 'string' ||
        !header.kid ||
        header.jwk ||
        header.jku ||
        header.x5u
      )
        deny('invalid_client');
      const { payload } = await jwtVerify(value, createLocalJWKSet(keys), {
        issuer: WEBSITE_CLIENT_ID,
        subject: WEBSITE_CLIENT_ID,
        audience: options.issuer,
        algorithms: ['ES256'],
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti'],
        maxTokenAge: 120,
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        payload.aud !== options.issuer ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > now ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 120 ||
        typeof payload.jti !== 'string' ||
        !payload.jti ||
        payload.jti.length > 128
      )
        deny('invalid_client');
    } catch (error) {
      if (invalidJwt(error)) deny('invalid_client');
      throw error;
    }
    // Native oauthClientAssertion consumes jti once, including across restarts.
  }
  async function invalidate(session: Session, reason: 'session-revocation' | 'logout' | 'refresh-replay') {
    const port = options.trustedAccess.invalidateAccount;
    if (!port) throw new Error('Access invalidation unavailable');
    const account = await options.trustedAccess.readAccount(session.userId);
    if (!account || account.accountId !== session.userId || account.authnEpoch < session.authnEpoch)
      deny('invalid_grant');
    const receipt = await port({ accountId: session.userId, previousEpoch: session.authnEpoch, reason });
    if (
      receipt.accountId !== session.userId ||
      !receipt.receiptId ||
      !Number.isSafeInteger(receipt.minimumAuthnEpoch) ||
      receipt.minimumAuthnEpoch <= session.authnEpoch
    )
      deny('invalid_grant');
    const current = await options.trustedAccess.readAccount(session.userId);
    if (!current || current.authnEpoch < receipt.minimumAuthnEpoch) deny('invalid_grant');
    // No Auth transaction is held across Access. The durable floor now denies
    // every older signed JWT, code and refresh even if physical cleanup fails.
  }
  async function form(request: Request): Promise<URLSearchParams> {
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
      deny('invalid_request');
    const reader = request.body?.getReader();
    if (!reader) deny('invalid_request');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 16384) deny('invalid_request');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return unique(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }
  function unique(fields: URLSearchParams) {
    const seen = new Set<string>();
    for (const [key, value] of fields) {
      if (seen.has(key) || value.length > 8192) deny('invalid_request');
      seen.add(key);
    }
    return fields;
  }
  function only(fields: URLSearchParams, allowed: string[]) {
    for (const key of fields.keys()) if (!allowed.includes(key)) deny('invalid_request');
  }
  function authorizationQuery(search: URLSearchParams) {
    const fields = new URLSearchParams();
    const seen = new Set<string>();
    for (const [key, value] of search) {
      if (value.length > 8192) deny('invalid_request');
      if (!authorizationParameters.has(key)) continue;
      if (seen.has(key)) deny('invalid_request');
      seen.add(key);
      fields.append(key, value);
    }
    return fields;
  }
  function resource(fields: URLSearchParams) {
    if (!fields.get('resource')) deny('invalid_request');
    if (fields.get('resource') !== options.audience) deny('invalid_target');
  }
  function nativeRequest(request: Request, path: string, fields?: URLSearchParams) {
    const url = new URL(`${options.issuer}/api/auth${path}`);
    const headers = new Headers(request.headers);
    if (request.method === 'GET') url.search = (fields ?? new URL(request.url).searchParams).toString();
    return new Request(url, {
      method: request.method,
      headers,
      ...(request.method === 'POST' ? { body: fields?.toString() ?? '' } : {}),
    });
  }
  async function familyActive(id: string) {
    return (
      (await database.query<{ revoked: boolean }>('SELECT revoked FROM "oauthRefreshFamily" WHERE id=$1', [id])).rows[0]
        ?.revoked === false
    );
  }
  async function remember(session: Session) {
    await database.query(
      `INSERT INTO auth_recent_oidc_session (session_id,account_id,expires_at) VALUES ($1,$2,statement_timestamp()+interval '10 minutes')
      ON CONFLICT (session_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [session.id, session.userId],
    );
  }
  return {
    plugin: {
      id: 'website-native-boundaries',
      init(context) {
        const adapter = context.adapter;
        return {
          context: {
            adapter: new Proxy(adapter, {
              get(target, key) {
                if (key === 'create')
                  return async (data: Parameters<typeof adapter.create>[0]) => {
                    const result = await adapter.create(data);
                    if (data.model === 'oauthClientAssertion') await assertionAdmission.getStore()?.();
                    return result;
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          },
        };
      },
    } satisfies BetterAuthPlugin,
    async beforeDeleteSession(deleted: { id: string }) {
      if (!logoutAdmission.getStore()) return;
      const session = await nativeSession(deleted.id);
      await remember(session);
      await invalidate(session, 'logout');
    },
    async claims() {
      const selected = issuance.getStore();
      if (!selected) throw new Error('Missing issuance context');
      await recheck(selected.session, selected.scopes);
      return { authn_epoch: selected.session.authnEpoch };
    },
    async accessClaims(payload: JWTPayload) {
      const selected = issuance.getStore();
      if (!selected) throw new Error('Missing issuance context');
      if (
        payload.sub !== selected.session.userId ||
        payload.client_id !== WEBSITE_CLIENT_ID ||
        payload.sid !== selected.session.id
      )
        throw new Error('Inconsistent issuance claims');
      await recheck(selected.session, selected.scopes);
      return {
        ...payload,
        aud: options.audience,
        authn_epoch: selected.session.authnEpoch,
        auth_time: selected.session.authTime,
        amr: selected.session.authMethods.split(' '),
      };
    },
    async register(registration: WebsiteClientRegistration) {
      const scopes = [...new Set(registration.scopes)].sort();
      if (
        scopes.length > input.scopeLimit ||
        scopes.some((s) => typeof s !== 'string' || s.length > 128 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)) ||
        ![...protocolScopes, 'media:complete'].every((s) => scopes.includes(s))
      )
        deny('invalid_request');
      if (options.siteActions && scopes.some((s) => !protocolScopes.includes(s) && !options.siteActions!.has(s)))
        deny('invalid_request');
      const keys = registration.publicJwks?.keys;
      if (
        !Array.isArray(keys) ||
        !keys.length ||
        keys.length > 3 ||
        new Set(keys.map((k) => k.kid)).size !== keys.length
      )
        deny('invalid_request');
      const publicKeys = [];
      for (const key of keys) {
        if (typeof key.kid !== 'string' || !key.kid || key.kid.length > 128 || key.alg !== 'ES256' || key.use !== 'sig')
          deny('invalid_request');
        publicKeys.push(await publicCredential(key, key.kid));
      }
      function uris(values: string[]) {
        if (!Array.isArray(values) || !values.length || values.length > 8 || new Set(values).size !== values.length)
          deny('invalid_request');
        for (const value of values) {
          const url = new URL(value);
          if (url.hash || url.username || url.password || url.search || url.href !== value) deny('invalid_request');
          const origin = issuerOrigin(url.origin);
          if (new URL(options.issuer).protocol === 'https:' && new URL(origin).protocol !== 'https:')
            deny('invalid_request');
        }
        return values;
      }
      const redirects = uris(registration.redirectUris),
        logout = uris(registration.postLogoutRedirectUris);
      const connection = await database.connect();
      try {
        await connection.query('BEGIN');
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `auth-client:${WEBSITE_CLIENT_ID}`,
        ]);
        if (
          (await connection.query('SELECT 1 FROM auth_client_reduction WHERE client_id=$1', [WEBSITE_CLIENT_ID]))
            .rowCount
        )
          deny('invalid_request');
        const prior = (
          await connection.query<{ scopes: string[] }>('SELECT scopes FROM auth_client WHERE client_id=$1 FOR UPDATE', [
            WEBSITE_CLIENT_ID,
          ])
        ).rows[0];
        if (prior?.scopes.some((s) => !scopes.includes(s))) deny('invalid_request');
        await connection.query(
          `INSERT INTO auth_client (client_id,first_party,scopes,jwks,"redirectUris","postLogoutRedirectUris","tokenEndpointAuthMethod","requirePKCE","enableEndSession","grantTypes","responseTypes","applicationType")
          VALUES ($1,true,$2,$3,$4,$5,'private_key_jwt',true,true,'["authorization_code","refresh_token"]'::jsonb,'["code"]'::jsonb,'web')
          ON CONFLICT (client_id) DO UPDATE SET scopes=EXCLUDED.scopes,jwks=EXCLUDED.jwks,"redirectUris"=EXCLUDED."redirectUris","postLogoutRedirectUris"=EXCLUDED."postLogoutRedirectUris"`,
          [
            WEBSITE_CLIENT_ID,
            scopes,
            JSON.stringify({ keys: publicKeys }),
            JSON.stringify(redirects),
            JSON.stringify(logout),
          ],
        );
        await connection.query(
          `INSERT INTO "oauthResource" (id,identifier,name,"allowedScopes","accessTokenTtl") VALUES ($1,$1,'REZICS API',$2,300)
          ON CONFLICT (identifier) DO UPDATE SET "allowedScopes"=EXCLUDED."allowedScopes","accessTokenTtl"=300`,
          [options.audience, JSON.stringify(scopes)],
        );
        await connection.query(
          `INSERT INTO "oauthClientResource" (id,"clientId","resourceId") VALUES ($1,$2,$3) ON CONFLICT ("clientId","resourceId") DO NOTHING`,
          [hash(`${WEBSITE_CLIENT_ID}:${options.audience}`), WEBSITE_CLIENT_ID, options.audience],
        );
        await connection.query(
          'INSERT INTO auth_client_coverage (client_id,ready,ready_after) VALUES ($1,true,CURRENT_TIMESTAMP) ON CONFLICT (client_id) DO NOTHING',
          [WEBSITE_CLIENT_ID],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
    async handler(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (
        ![
          '/.well-known/openid-configuration',
          '/.well-known/oauth-authorization-server',
          '/authorize',
          '/logout',
          '/logout/confirm',
          '/revoke',
          '/token',
          '/login',
        ].includes(url.pathname)
      )
        return;
      if (
        url.pathname === '/token' &&
        request.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json'
      )
        return;
      return protocolResponse(async () => {
        if (url.origin !== options.issuer) deny('invalid_request');
        if (url.pathname.startsWith('/.well-known/')) {
          if (request.method !== 'GET' || url.search) deny('invalid_request');
          const response = await input.native().handler(request);
          if (!response.ok) return response;
          const metadata = await response.json();
          return Response.json(
            {
              ...metadata,
              issuer: options.issuer,
              authorization_endpoint: `${options.issuer}/authorize`,
              token_endpoint: `${options.issuer}/token`,
              revocation_endpoint: `${options.issuer}/revoke`,
              end_session_endpoint: `${options.issuer}/logout`,
              jwks_uri: `${options.issuer}/.well-known/jwks.json`,
              token_endpoint_auth_methods_supported: ['private_key_jwt'],
              token_endpoint_auth_signing_alg_values_supported: ['ES256'],
              scopes_supported: (await client()).scopes,
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        if (url.pathname === '/authorize') {
          if (request.method !== 'GET') deny('invalid_request');
          const fields = authorizationQuery(url.searchParams);
          const registered = await client();
          if (
            fields.get('client_id') !== WEBSITE_CLIENT_ID ||
            !registered.redirectUris.includes(fields.get('redirect_uri') ?? '') ||
            fields.get('response_type') !== 'code' ||
            !fields.get('state') ||
            fields.get('code_challenge_method') !== 'S256' ||
            !/^[A-Za-z0-9_-]{43}$/.test(fields.get('code_challenge') ?? '')
          )
            deny('invalid_request');
          resource(fields);
          const scopes = (fields.get('scope') ?? '').split(' ');
          if (!protocolScopes.every((s) => scopes.includes(s)) || scopes.some((s) => !registered.scopes.includes(s)))
            deny('invalid_request');
          const current = await input
            .native()
            .api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
          if (current) {
            await input.sessionProof(request.headers);
            await proof(current.session, scopes, true);
          }
          // The session above is the one already loaded for this request.
          const stepUp =
            current !== null &&
            (asksForLogin(fields.get('prompt')) ||
              authenticationIsStale(current.session.authTime, fields.get('max_age')));
          // Native max_age follows session creation, not auth_time. prompt=login
          // makes an aged auth_time take the same login redirect, which we rewrite.
          if (stepUp && !asksForLogin(fields.get('prompt'))) {
            const prompt = fields.get('prompt');
            fields.set('prompt', prompt ? `${prompt} login` : 'login');
          }
          return input.withIssuance(WEBSITE_CLIENT_ID, async () => {
            if (current && !stepUp) {
              await database.query(
                `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3) ON CONFLICT (account_id,client_id) DO NOTHING`,
                [current.session.userId, WEBSITE_CLIENT_ID, registered.scopes],
              );
              await proof(current.session, scopes);
            }
            const response = await input.native().handler(nativeRequest(request, '/oauth2/authorize', fields));
            if (!stepUp) return response;
            const rewritten = stepUpLocation(response.headers.get('location') ?? '', options.issuer);
            if (!rewritten) return response;
            const headers = new Headers(response.headers);
            headers.set('location', rewritten);
            return new Response(response.body, { status: response.status, headers });
          });
        }
        if (url.pathname === '/token' || url.pathname === '/revoke') {
          if (request.method !== 'POST' || url.search) deny('invalid_request');
          const fields = await form(request);
          const base = ['client_id', 'client_assertion_type', 'client_assertion', 'resource'];
          if (url.pathname === '/revoke') {
            only(fields, [...base, 'token', 'token_type_hint']);
            await assertion(fields);
            let row = (
              await database.query<{ sessionId: string; clientId: string }>(
                'SELECT "sessionId","clientId" FROM "oauthRefreshToken" WHERE token=$1',
                [hash(fields.get('token') ?? '')],
              )
            ).rows[0];
            if (!row && fields.get('token_type_hint') !== 'refresh_token') {
              const keys = createLocalJWKSet(await input.getJwks());
              try {
                const { payload } = await jwtVerify(fields.get('token') ?? '', keys, {
                  issuer: options.issuer,
                  audience: options.audience,
                  algorithms: ['ES256'],
                  typ: 'at+jwt',
                });
                if (payload.client_id === WEBSITE_CLIENT_ID && typeof payload.sid === 'string')
                  row = { sessionId: payload.sid, clientId: WEBSITE_CLIENT_ID };
              } catch (error) {
                if (!invalidJwt(error)) throw error;
                // RFC 7009: an unknown or expired token is a successful no-op.
              }
            }
            // Revocation cannot issue authority. Do not hold the issuance
            // connection while native JWT verification fetches public JWKS.
            let invalidated = false;
            const response = await assertionAdmission.run(
              async () => {
                // An ended session was already invalidated Access-first by logout or
                // revocation; the native family revocation still follows.
                const session =
                  row && row.clientId === WEBSITE_CLIENT_ID && row.sessionId
                    ? (await database.query<Session>('SELECT * FROM session WHERE id=$1', [row.sessionId])).rows[0]
                    : undefined;
                if (session) {
                  await remember(session);
                  await invalidate(session, 'session-revocation');
                  invalidated = true;
                }
              },
              () => input.native().handler(nativeRequest(request, '/oauth2/revoke', fields)),
            );
            // Native RFC 7009 cannot revoke self-contained JWTs. Our existing
            // Access floor does, after native confidential proof admission.
            if (
              invalidated &&
              response.status === 400 &&
              (await response.clone().json()).error === 'unsupported_token_type'
            )
              return Response.json(null, { headers: { 'cache-control': 'no-store' } });
            return response;
          }
          const grant = fields.get('grant_type');
          if (!grant) deny('invalid_request');
          only(fields, [
            ...base,
            'grant_type',
            ...(grant === 'authorization_code'
              ? ['code', 'redirect_uri', 'code_verifier']
              : grant === 'refresh_token'
                ? ['refresh_token', 'scope']
                : []),
          ]);
          await assertion(fields);
          resource(fields);
          let sessionId: string, scopes: string[], family: string | undefined;
          if (grant === 'authorization_code') {
            if (!fields.get('code') || !fields.get('redirect_uri') || !fields.get('code_verifier'))
              deny('invalid_request');
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(fields.get('code_verifier')!)) deny('invalid_grant');
            const record = (
              await database.query<{ value: string }>(
                'SELECT value FROM verification WHERE identifier=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
                [hash(fields.get('code') ?? '')],
              )
            ).rows[0];
            if (!record)
              return input.withIssuance(WEBSITE_CLIENT_ID, () =>
                input.native().handler(nativeRequest(request, '/oauth2/token', fields)),
              );
            const verification = JSON.parse(record.value);
            sessionId = verification.sessionId;
            scopes = verification.query.scope.split(' ');
          } else if (grant === 'refresh_token') {
            if (!fields.get('refresh_token')) deny('invalid_request');
            const record = (
              await database.query<{
                sessionId: string;
                clientId: string;
                scopes: string[];
                authorizationCodeId: string | null;
              }>('SELECT "sessionId","clientId",scopes,"authorizationCodeId" FROM "oauthRefreshToken" WHERE token=$1', [
                hash(fields.get('refresh_token') ?? ''),
              ])
            ).rows[0];
            if (!record || record.clientId !== WEBSITE_CLIENT_ID || !record.authorizationCodeId) deny('invalid_grant');
            // A revoked family is final; refuse before any native issuance work.
            if (!(await familyActive(record.authorizationCodeId))) deny('invalid_grant');
            sessionId = record.sessionId;
            scopes = fields.has('scope') ? fields.get('scope')!.split(' ') : record.scopes;
            if (scopes.some((scope) => !record.scopes.includes(scope))) deny('invalid_scope');
            family = record.authorizationCodeId;
          } else deny('unsupported_grant_type');
          const session = await proof(await nativeSession(sessionId), scopes);
          const response = await input.withIssuance(WEBSITE_CLIENT_ID, () =>
            issuance.run({ session, scopes }, () =>
              input.native().handler(nativeRequest(request, '/oauth2/token', fields)),
            ),
          );
          // The native guard revokes a family on reuse, including a replay that
          // raced a rotation. That transition also ends minted JWT authority.
          if (family && response.status !== 200 && !(await familyActive(family))) {
            await remember(session);
            await invalidate(session, 'refresh-replay');
          }
          return response;
        }
        if (url.pathname === '/logout' || url.pathname === '/logout/confirm') {
          if (!['GET', 'POST'].includes(request.method)) deny('invalid_request');
          const fields = request.method === 'GET' ? unique(url.searchParams) : await form(request);
          if (request.method === 'POST' && url.search) deny('invalid_request');
          if (url.pathname === '/logout/confirm') {
            if (request.method !== 'POST') deny('invalid_request');
            only(fields, ['action']);
          }
          if (url.pathname === '/logout') {
            only(fields, ['client_id', 'id_token_hint', 'post_logout_redirect_uri', 'state']);
            const registered = await client();
            if (
              fields.has('post_logout_redirect_uri') &&
              !registered.postLogoutRedirectUris.includes(fields.get('post_logout_redirect_uri')!)
            )
              deny('invalid_request');
            if (fields.has('id_token_hint')) {
              const keys = createLocalJWKSet(await input.getJwks());
              let payload: Uint8Array;
              try {
                ({ payload } = await compactVerify(fields.get('id_token_hint')!, keys, { algorithms: ['ES256'] }));
              } catch (error) {
                if (invalidJwt(error)) deny('invalid_request');
                throw error;
              }
              const hint = JSON.parse(new TextDecoder().decode(payload)) as JWTPayload;
              if (
                hint.iss !== options.issuer ||
                hint.aud !== WEBSITE_CLIENT_ID ||
                typeof hint.sid !== 'string' ||
                typeof hint.sub !== 'string' ||
                (fields.has('client_id') && fields.get('client_id') !== WEBSITE_CLIENT_ID)
              )
                deny('invalid_request');
              const current = await input.native().api.getSession({
                headers: request.headers,
                query: { disableCookieCache: true, disableRefresh: true },
              });
              const recent = (
                await database.query<{ account_id: string }>(
                  'SELECT account_id FROM auth_recent_oidc_session WHERE session_id=$1 AND expires_at>statement_timestamp()',
                  [hint.sid],
                )
              ).rows[0];
              const hinted = (await database.query<Session>('SELECT * FROM session WHERE id=$1', [hint.sid])).rows[0];
              if ((hinted?.userId ?? recent?.account_id) !== hint.sub) deny('invalid_request');
              if (current?.session.id === hint.sid && hinted && current.session.userId !== hint.sub)
                deny('invalid_request');
            }
          }
          const response = await logoutAdmission.run(true, () =>
            input
              .native()
              .handler(
                nativeRequest(
                  request,
                  url.pathname === '/logout' ? '/oauth2/end-session' : '/oauth2/end-session/confirm',
                  fields,
                ),
              ),
          );
          // Keep the provider's signed, session-bound confirmation state and
          // HTML form, adapting only its private endpoint path to the alias.
          const headers = new Headers(response.headers);
          headers.delete('set-cookie');
          for (const cookie of response.headers.getSetCookie())
            headers.append(
              'set-cookie',
              cookie.replace('Path=/api/auth/oauth2/end-session/confirm', 'Path=/logout/confirm'),
            );
          if (response.headers.get('content-type')?.startsWith('text/html')) {
            headers.delete('content-length');
            return new Response(
              (await response.text()).replaceAll(
                `${options.issuer}/api/auth/oauth2/end-session/confirm`,
                `${options.issuer}/logout/confirm`,
              ),
              { status: response.status, headers },
            );
          }
          return new Response(response.body, { status: response.status, headers });
        }
        // Browser login uses the public signin alias, whose real Better Auth
        // credential/session hooks retain their origin and rate protections.
        if (url.pathname === '/login' && request.method === 'GET')
          return new Response(
            'Sign in at /signin using the registered login client, then resume the authorization URL.',
            { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
          );
        deny('invalid_request');
      }, url.pathname === '/token');
    },
  };
}
