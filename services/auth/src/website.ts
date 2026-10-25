import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { compactVerify, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { Pool } from 'pg';
import type { BetterAuthPlugin } from 'better-auth';
import type { AuthServiceOptions, PublicJwks, SessionProof, WebsiteClientRegistration } from './index.ts';
import { publicCredential } from './key-credentials.ts';
import { issuerOrigin } from './issuer.ts';

export const WEBSITE_CLIENT_ID = 'rezics-website';
const protocolScopes = ['openid', 'offline_access'];
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
class ProtocolDenied extends Error {}
function deny(): never {
  throw new ProtocolDenied();
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
    return row ?? deny();
  }
  async function proof(session: Session, scopes: string[]) {
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
      session.authMethods !== 'pwd'
    )
      deny();
    const registered = await client();
    if (scopes.some((scope) => !registered.scopes.includes(scope))) deny();
    // The existing first-party consent projection is also the reduction index.
    // Its current contents never supply resource or principal grants.
    const consent = (
      await database.query<{ scopes: string[] }>(
        'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
        [session.userId, WEBSITE_CLIENT_ID],
      )
    ).rows[0];
    if (consent && scopes.some((scope) => !consent.scopes.includes(scope))) deny();
    return session;
  }
  async function nativeSession(id: string): Promise<Session> {
    return (await database.query<Session>('SELECT * FROM session WHERE id=$1', [id])).rows[0] ?? deny();
  }
  async function assertion(fields: URLSearchParams) {
    if (
      fields.get('client_id') !== WEBSITE_CLIENT_ID ||
      fields.get('client_assertion_type') !== assertionType ||
      fields.has('client_secret')
    )
      deny();
    const value = fields.get('client_assertion') ?? deny();
    const header = decodeProtectedHeader(value);
    if (
      header.alg !== 'ES256' ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.jwk ||
      header.jku ||
      header.x5u
    )
      deny();
    const keys: PublicJwks = JSON.parse((await client()).jwks);
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
      deny();
    // Native oauthClientAssertion consumes jti once, including across restarts.
  }
  async function invalidate(session: Session, reason: 'session-revocation' | 'logout' | 'refresh-replay') {
    const port = options.trustedAccess.invalidateAccount;
    if (!port) deny();
    const account = await options.trustedAccess.readAccount(session.userId);
    if (!account || account.accountId !== session.userId || account.authnEpoch < session.authnEpoch) deny();
    const receipt = await port({ accountId: session.userId, previousEpoch: session.authnEpoch, reason });
    if (
      receipt.accountId !== session.userId ||
      !receipt.receiptId ||
      !Number.isSafeInteger(receipt.minimumAuthnEpoch) ||
      receipt.minimumAuthnEpoch <= session.authnEpoch
    )
      deny();
    const current = await options.trustedAccess.readAccount(session.userId);
    if (!current || current.authnEpoch < receipt.minimumAuthnEpoch) deny();
    // No Auth transaction is held across Access. The durable floor now denies
    // every older signed JWT, code and refresh even if physical cleanup fails.
  }
  async function form(request: Request): Promise<URLSearchParams> {
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') deny();
    const reader = request.body?.getReader();
    if (!reader) deny();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 16384) deny();
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
      if (seen.has(key) || value.length > 8192) deny();
      seen.add(key);
    }
    return fields;
  }
  function only(fields: URLSearchParams, allowed: string[]) {
    for (const key of fields.keys()) if (!allowed.includes(key)) deny();
  }
  function resource(fields: URLSearchParams) {
    if (fields.get('resource') !== options.audience) deny();
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
      const selected = issuance.getStore() ?? deny();
      await proof(selected.session, selected.scopes);
      return { authn_epoch: selected.session.authnEpoch };
    },
    async accessClaims(payload: JWTPayload) {
      const selected = issuance.getStore() ?? deny();
      if (
        payload.sub !== selected.session.userId ||
        payload.client_id !== WEBSITE_CLIENT_ID ||
        payload.sid !== selected.session.id
      )
        deny();
      await proof(selected.session, selected.scopes);
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
        scopes.length > 100 ||
        scopes.some((s) => typeof s !== 'string' || s.length > 128 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)) ||
        ![...protocolScopes, 'media:complete'].every((s) => scopes.includes(s))
      )
        deny();
      if (options.siteActions && scopes.some((s) => !protocolScopes.includes(s) && !options.siteActions!.has(s)))
        deny();
      const keys = registration.publicJwks?.keys;
      if (
        !Array.isArray(keys) ||
        !keys.length ||
        keys.length > 3 ||
        new Set(keys.map((k) => k.kid)).size !== keys.length
      )
        deny();
      const publicKeys = [];
      for (const key of keys) {
        if (typeof key.kid !== 'string' || !key.kid || key.kid.length > 128 || key.alg !== 'ES256' || key.use !== 'sig')
          deny();
        publicKeys.push(await publicCredential(key, key.kid));
      }
      function uris(values: string[]) {
        if (!Array.isArray(values) || !values.length || values.length > 8 || new Set(values).size !== values.length)
          deny();
        for (const value of values) {
          const url = new URL(value);
          if (url.hash || url.username || url.password || url.search || url.href !== value) deny();
          const origin = issuerOrigin(url.origin);
          if (new URL(options.issuer).protocol === 'https:' && new URL(origin).protocol !== 'https:') deny();
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
          deny();
        const prior = (
          await connection.query<{ scopes: string[] }>('SELECT scopes FROM auth_client WHERE client_id=$1 FOR UPDATE', [
            WEBSITE_CLIENT_ID,
          ])
        ).rows[0];
        if (prior?.scopes.some((s) => !scopes.includes(s))) deny();
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
      try {
        if (url.origin !== options.issuer) deny();
        if (url.pathname.startsWith('/.well-known/')) {
          if (request.method !== 'GET' || url.search) deny();
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
          if (request.method !== 'GET') deny();
          const fields = unique(url.searchParams);
          only(fields, [
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
          const registered = await client();
          if (
            fields.get('client_id') !== WEBSITE_CLIENT_ID ||
            !registered.redirectUris.includes(fields.get('redirect_uri') ?? '') ||
            fields.get('response_type') !== 'code' ||
            !fields.get('state') ||
            fields.get('code_challenge_method') !== 'S256' ||
            !/^[A-Za-z0-9_-]{43}$/.test(fields.get('code_challenge') ?? '')
          )
            deny();
          resource(fields);
          const scopes = (fields.get('scope') ?? '').split(' ');
          if (!protocolScopes.every((s) => scopes.includes(s)) || scopes.some((s) => !registered.scopes.includes(s)))
            deny();
          const current = await input
            .native()
            .api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
          if (current) {
            await input.sessionProof(request.headers);
            await proof(current.session, scopes);
          }
          return input.withIssuance(WEBSITE_CLIENT_ID, async () => {
            if (current)
              await database.query(
                `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3) ON CONFLICT (account_id,client_id) DO NOTHING`,
                [current.session.userId, WEBSITE_CLIENT_ID, registered.scopes],
              );
            return input.native().handler(nativeRequest(request, '/oauth2/authorize', fields));
          });
        }
        if (url.pathname === '/token' || url.pathname === '/revoke') {
          if (request.method !== 'POST' || url.search) deny();
          const fields = await form(request);
          await assertion(fields);
          const base = ['client_id', 'client_assertion_type', 'client_assertion', 'resource'];
          if (url.pathname === '/revoke') {
            only(fields, [...base, 'token', 'token_type_hint']);
            const row = (
              await database.query<{ sessionId: string; clientId: string }>(
                'SELECT "sessionId","clientId" FROM "oauthRefreshToken" WHERE token=$1',
                [hash(fields.get('token') ?? '')],
              )
            ).rows[0];
            return input.withIssuance(WEBSITE_CLIENT_ID, () =>
              assertionAdmission.run(
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
                  }
                },
                () => input.native().handler(nativeRequest(request, '/oauth2/revoke', fields)),
              ),
            );
          }
          resource(fields);
          const grant = fields.get('grant_type');
          let sessionId: string, scopes: string[], family: string | undefined;
          if (grant === 'authorization_code') {
            only(fields, [...base, 'grant_type', 'code', 'redirect_uri', 'code_verifier']);
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(fields.get('code_verifier') ?? '')) deny();
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
            only(fields, [...base, 'grant_type', 'refresh_token', 'scope']);
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
            if (!record || record.clientId !== WEBSITE_CLIENT_ID || !record.authorizationCodeId) deny();
            // A revoked family is final; refuse before any native issuance work.
            if (!(await familyActive(record.authorizationCodeId))) deny();
            sessionId = record.sessionId;
            scopes = fields.has('scope') ? fields.get('scope')!.split(' ') : record.scopes;
            family = record.authorizationCodeId;
          } else deny();
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
          if (!['GET', 'POST'].includes(request.method)) deny();
          const fields = request.method === 'GET' ? unique(url.searchParams) : await form(request);
          if (request.method === 'POST' && url.search) deny();
          if (url.pathname === '/logout') {
            only(fields, ['client_id', 'id_token_hint', 'post_logout_redirect_uri', 'state']);
            const registered = await client();
            if (
              fields.has('post_logout_redirect_uri') &&
              !registered.postLogoutRedirectUris.includes(fields.get('post_logout_redirect_uri')!)
            )
              deny();
            if (fields.has('id_token_hint')) {
              const { payload } = await compactVerify(
                fields.get('id_token_hint')!,
                createLocalJWKSet(await input.getJwks()),
                { algorithms: ['ES256'] },
              );
              const hint = JSON.parse(new TextDecoder().decode(payload)) as JWTPayload;
              if (
                hint.iss !== options.issuer ||
                hint.aud !== WEBSITE_CLIENT_ID ||
                typeof hint.sid !== 'string' ||
                typeof hint.sub !== 'string' ||
                (fields.has('client_id') && fields.get('client_id') !== WEBSITE_CLIENT_ID)
              )
                deny();
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
              if ((hinted?.userId ?? recent?.account_id) !== hint.sub) deny();
              if (current?.session.id === hint.sid && hinted && current.session.userId !== hint.sub) deny();
            }
          }
          return logoutAdmission.run(true, () =>
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
        }
        // Browser login uses the public signin alias, whose real Better Auth
        // credential/session hooks retain their origin and rate protections.
        if (url.pathname === '/login' && request.method === 'GET')
          return new Response(
            'Sign in at /signin using the registered login client, then resume the authorization URL.',
            { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
          );
        deny();
      } catch {
        return Response.json({ error: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'no-store' } });
      }
    },
  };
}
