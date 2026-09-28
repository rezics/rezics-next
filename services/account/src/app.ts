import { Elysia, NotFound, ParseError, ValidationError, t } from 'elysia';
import { toOpenAPISchema } from '@elysia/openapi';
import { Pool } from 'pg';
import type { createAccountAuth } from './auth.ts';
import { currentInstallationIn, installClient, InstallationConflict, InstallationInvalid,
  InstallationNotFound, readInstallation, revokeInstallation } from './installations.ts';
import { currentIntrospection, presentedToken } from './introspection.ts';
import { guardedAuthorizationCodeExchange } from './oauth-code-guard.ts';
import { guardedRefreshTokenExchange } from './refresh-token-guard.ts';
import { consumeAccountLimit } from './rate-limit.ts';
import { consentApi } from './consent.ts';
import { methodsApi, requireStepUp, sensitiveAuthPaths } from './methods.ts';
import { accountFailure, accountSession } from './http.ts';
import { observeAuthentication, securityActivityApi } from './security-activity.ts';
import { recordSessionClient } from './sessions.ts';
import { connectedAppsApi } from './connected-apps.ts';
import { dataExportApi } from './data-export.ts';
import { adminApi } from './admin.ts';
import { accountSettingsApi } from './account-settings.ts';
import { displayPreferencesApi } from './display-preferences.ts';
import { emailChangeApi } from './email-change.ts';
import { notificationDigestApi } from './notification-digest.ts';
import { bootstrapOperators, requireOperator } from './operators.ts';
import { AccountRecoveryConflict, AccountRecoveryDenied, AccountRecoveryStale,
  activateAccountRecovery, approveAccountRecovery, enrollAccountRecovery,
  readAccountRecoveryClaim, requestAccountRecovery } from './recovery-claim.ts';

export interface AccountAppOptions {
  /** Verified private user IDs allowed to change App installations. */
  operatorUserIds?: ReadonlySet<string>;
  /** Connections the authorization-code guard may hold across exchanges. */
  codeGuardConnections?: number;
  /** First-party web OAuth client IDs admitted to account display preferences. */
  displayPreferenceClientIds?: ReadonlySet<string>;
  notificationDigest?: { accountSecret: string; mainSecret: string };
}

const installationView = t.Object({ installationId: t.String(), clientId: t.String(),
  state: t.Union([t.Literal('active'), t.Literal('revoked')]), scopes: t.Array(t.String()),
  installedAt: t.String(), revokedAt: t.Nullable(t.String()) });
const accountProblem = t.Object({ error: t.String() });
const recoveryCode = t.String({ pattern: '^[A-Za-z0-9_-]{43}$' });
const recoveryId = t.String({ format: 'uuid' });
const recoveryView = t.Object({ claimId: t.String(), targetUserId: t.String(),
  notBefore: t.String(), expiresAt: t.String(), approved: t.Boolean(),
  activated: t.Boolean(), replayed: t.Boolean() });

export function createAccountApp(auth: ReturnType<typeof createAccountAuth>, pool: Pool,
  options: AccountAppOptions = {}) {
  const origin = new URL(String(auth.options.baseURL)).origin;
  // pg-pool emits errors for idle clients on the pool, but removes its client
  // listener while a connection is checked out. A database cut can then reject
  // the pending query and emit an unhandled client error before the caller
  // returns its unavailable response. Keep one listener for each client.
  const idleConnectionError = (error: Error) => {
    console.error('Account database idle connection failed:', error.message);
  };
  const observePool = (databasePool: Pool): Pool => {
    const observed = new WeakSet<object>();
    databasePool.on('error', idleConnectionError);
    databasePool.on('acquire', client => {
      if (observed.has(client)) return;
      observed.add(client);
      client.on('error', (error: Error) => {
        if (client.listenerCount('error') === 1) {
          console.error('Account database active connection failed:', error.message);
        }
      });
    });
    return databasePool;
  };
  observePool(pool);
  // The guard holds its own bounded connections across a provider exchange,
  // which draws on the owner pool. Excess concurrent exchanges wait at most
  // five seconds for a guard connection, then fail as temporarily unavailable;
  // they never take the connections the exchange itself needs.
  let guardPool: Pool | undefined;
  // pg-pool deliberately hides an explicit password from object spreads.
  // Preserve it when the guard uses its own pool (remote Account placements
  // commonly configure host, user and password separately).
  const guard = () => guardPool ??= observePool(new Pool({ ...pool.options,
    ...('password' in pool.options ? { password: pool.options.password } : {}),
    max: options.codeGuardConnections ?? 4, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000, allowExitOnIdle: true }));
  const operator = async (request: Request, write: boolean): Promise<string | Response> => {
    try {
      await bootstrapOperators(pool, options.operatorUserIds ?? new Set());
      return (await requireOperator(auth, pool, request, 'clients:manage', write)).userId;
    } catch (error) { return accountFailure(error); }
  };
  const installationError = (error: unknown) => {
    if (error instanceof InstallationNotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    if (error instanceof InstallationConflict) return Response.json({ error: 'conflict' }, { status: 409 });
    if (error instanceof InstallationInvalid) return Response.json({ error: 'invalid_scope' }, { status: 400 });
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  };
  const accountActor = async (request: Request): Promise<{
    userId: string; sessionId: string } | Response> => {
    if (request.headers.get('origin') !== origin) {
      return Response.json({ error: 'invalid_origin' }, { status: 403 });
    }
    let session;
    try { session = await auth.api.getSession({ headers: request.headers }); }
    catch { return Response.json({ error: 'temporarily_unavailable' }, { status: 503 }); }
    return session ? { userId: session.user.id, sessionId: session.session.id }
      : Response.json({ error: 'unauthenticated' }, { status: 401 });
  };
  const recoveryError = (error: unknown): Response => {
    if (error instanceof AccountRecoveryDenied) {
      return Response.json({ error: 'recovery_denied' }, { status: 403 });
    }
    if (error instanceof AccountRecoveryConflict || error instanceof AccountRecoveryStale) {
      return Response.json({ error: 'recovery_conflict' }, { status: 409 });
    }
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  };
  // A credential mutation already admitted under an old session must finish
  // before recovery rotates the credential, or observe the new recovery fence
  // and fail. Holding the policy's share lock through Better Auth's handler
  // gives those writes the same ordering as recovery activation's update.
  const credentialPaths = new Set([...sensitiveAuthPaths].filter(path => path !== '/api/auth/delete-user'));
  credentialPaths.add('/api/auth/update-user');
  credentialPaths.add('/api/auth/two-factor/verify-totp');
  const guardedAuthHandler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/auth/two-factor/verify-totp') {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session) {
        const pending = await pool.query('SELECT 1 FROM "twoFactor" WHERE "userId" = $1 AND verified = false', [session.user.id]);
        if (pending.rowCount) {
          try { await requireStepUp(pool, session); } catch (error) { return accountFailure(error); }
        }
      }
    }
    if (request.method === 'POST' && (path === '/api/auth/sign-in/email' || path === '/api/auth/reset-password'
      || path === '/api/auth/passkey/verify-authentication' || path.startsWith('/api/auth/two-factor/verify-'))) {
      try {
        const body = await request.clone().json().catch(() => ({})) as { email?: unknown; token?: unknown; response?: { id?: unknown } };
        const target = typeof body.email === 'string' ? body.email.toLowerCase()
          : typeof body.token === 'string' ? body.token
          : typeof body.response?.id === 'string' ? body.response.id
          : request.headers.get('cookie')?.split(';').find(value => value.includes('two_factor='))?.trim() ?? 'anonymous';
        if (!await consumeAccountLimit(pool, String(auth.options.secret), `authenticate:${path}:${target}`, 20, 300)) {
          return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '300' } });
        }
      } catch (error) { return accountFailure(error); }
    }
    if (sensitiveAuthPaths.has(path)) {
      try {
        // Browsers send no Origin on a same-origin GET (passkey registration
        // options); SameSite cookies already keep cross-site GETs signed out.
        const session = await accountSession(auth, request);
        await requireStepUp(pool, session);
      } catch (error) { return accountFailure(error); }
    }
    const emailPaths = new Set(['/api/auth/sign-up/email', '/api/auth/request-password-reset',
      '/api/auth/send-verification-email']);
    if (request.method === 'POST' && emailPaths.has(path)) {
      const body = await request.clone().json().catch(() => null) as { email?: unknown } | null;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email.length <= 320) {
        try {
          if (!await consumeAccountLimit(pool, String(auth.options.secret), `${path}:${email}`, 3, 300)) {
            return Response.json({ error: 'rate_limited' }, { status: 429,
              headers: { 'retry-after': '300' } });
          }
        } catch { return Response.json({ error: 'temporarily_unavailable' }, { status: 503 }); }
      }
      const response = await auth.handler(request);
      // Strip the provider's synthetic user too: future plugin fields must not
      // turn sign-up back into a public account-directory oracle.
      return response.ok && path === '/api/auth/sign-up/email'
        && auth.options.emailAndPassword?.requireEmailVerification
        ? Response.json({ status: true }, { headers: { 'cache-control': 'no-store' } }) : response;
    }
    if (request.method !== 'POST' || !credentialPaths.has(new URL(request.url).pathname)) {
      return auth.handler(request);
    }
    let session;
    try { session = await auth.api.getSession({ headers: request.headers }); }
    catch { return Response.json({ error: 'temporarily_unavailable' }, { status: 503 }); }
    if (!session) return auth.handler(request);
    const client = await guard().connect().catch(() => null);
    if (!client) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const current = await client.query<{ recovered_at: Date | null }>(`SELECT recovered_at
        FROM public.rezics_account_recovery_policy WHERE id = $1 FOR SHARE`, [session.user.id]);
      const existing = await client.query(`SELECT 1 FROM public."session"
        WHERE id = $1 AND "userId" = $2
          AND ($3::timestamptz IS NULL OR "createdAt" > $3)`,
      [session.session.id, session.user.id, current.rows[0]?.recovered_at ?? null]);
      if (!existing.rowCount) {
        await client.query('ROLLBACK');
        return Response.json({ error: 'stale_credential_session' }, { status: 403 });
      }
      const response = await auth.handler(request);
      await client.query('COMMIT');
      return response;
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* preserve unavailability */ }
      return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    } finally { client.release(); }
  };
  const app = new Elysia({ introspect: true })
    .error(({ error }) => {
      if (error instanceof ValidationError || error instanceof ParseError) return Response.json({ error: 'invalid_request' }, { status: 400 });
      if (error instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
      return accountFailure(error);
    })
    .get('/health/live', { response: t.Object({ status: t.Literal('ok') }) },
      () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready') }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      // A partitioned database can leave a connection attempt unanswered;
      // readiness reports unavailable within two seconds instead of hanging.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pool.query('SELECT 1'), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('readiness timeout')), 2_000);
        })]);
        return { status: 'ready' as const };
      } catch {
        return status(503, { status: 'unavailable' as const });
      } finally { clearTimeout(timer); }
    })
    .post('/api/auth/oauth2/introspect', async ({ request }) => {
      const token = await presentedToken(request.clone());
      return currentIntrospection(pool, token, await auth.handler(request));
    })
    .use(options.notificationDigest ? notificationDigestApi(pool,
      options.notificationDigest.accountSecret, options.notificationDigest.mainSecret, origin) : new Elysia())
    .use(consentApi(auth, pool))
    .use(methodsApi(auth, pool))
    .use(emailChangeApi(auth, pool))
    .use(securityActivityApi(auth, pool))
    .use(connectedAppsApi(auth, pool))
    .use(dataExportApi(auth, pool))
    .use(adminApi(auth, pool))
    .use(accountSettingsApi(auth, pool))
    .use(displayPreferencesApi(auth, pool, options.displayPreferenceClientIds ?? new Set()))
    .post('/api/auth/oauth2/token', ({ request }) =>
      guardedAuthorizationCodeExchange(guard(), request, () =>
        guardedRefreshTokenExchange(guard(), request, () => auth.handler(request))))
    // A product must bind and consume state at its callback. Require the input
    // here as well so an authorization request cannot omit that CSRF binding.
    // An App asks only within its active installation, so neither consent nor
    // a code is recorded beyond the installed ceiling after an App update.
    .get('/api/auth/oauth2/authorize', async ({ request }) => {
      const query = new URL(request.url).searchParams;
      const states = query.getAll('state');
      if (states.length !== 1 || !states[0]) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      const clientIds = query.getAll('client_id');
      if (clientIds.length === 1 && clientIds[0]) {
        const scopes = (query.get('scope') ?? '').split(' ').filter(Boolean);
        let installation;
        try { installation = await currentInstallationIn(pool, clientIds[0], scopes); }
        catch { return Response.json({ error: 'temporarily_unavailable' }, { status: 503 }); }
        // An unknown client has no installation; the provider reports it.
        if (installation && !installation.covers) {
          return Response.json({ error: 'invalid_scope' }, { status: 400 });
        }
        if (!installation) {
          const known = await pool.query('SELECT 1 FROM public."oauthClient" WHERE "clientId" = $1',
            [clientIds[0]]).catch(() => null);
          if (!known) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
          if (known.rowCount) return Response.json({ error: 'unauthorized_client' }, { status: 400 });
        }
      }
      const response = await auth.handler(request);
      await recordSessionClient(auth, pool, request, response, clientIds.length === 1 ? clientIds[0]! : null)
        .catch(() => console.error('Account session client label unavailable'));
      return response;
    })
    .get('/api/account/installations/:clientId', {
      params: t.Object({ clientId: t.String({ minLength: 1, maxLength: 256 }) }),
      response: { 200: installationView, 401: accountProblem, 403: accountProblem,
        404: accountProblem, 503: accountProblem },
    }, async ({ request, params }) => {
      const actor = await operator(request, false);
      if (actor instanceof Response) return actor;
      try { return Response.json(await readInstallation(pool, params.clientId),
        { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return installationError(error); }
    })
    // Revocation is terminal and idempotent by installation ID. Installing a
    // new ceiling needs an operator change key, and never replaces an active
    // installation; each is O(1) indexed statements.
    .post('/api/account/installation-changes', {
      body: t.Union([
        t.Object({ change: t.Literal('revoke'),
          installationId: t.String({ minLength: 1, maxLength: 64 }) },
        { additionalProperties: false }),
        t.Object({ change: t.Literal('install'),
          clientId: t.String({ minLength: 1, maxLength: 256 }),
          scopes: t.Array(t.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64 }),
          changeKey: t.String({ minLength: 1, maxLength: 128 }) },
        { additionalProperties: false }),
      ]),
      response: { 200: installationView, 400: accountProblem, 401: accountProblem,
        403: accountProblem, 404: accountProblem, 409: accountProblem, 503: accountProblem },
    }, async ({ request, body }) => {
      const actor = await operator(request, true);
      if (actor instanceof Response) return actor;
      try {
        const result = body.change === 'revoke'
          ? await revokeInstallation(pool, { installationId: body.installationId, operatorUserId: actor })
          : await installClient(pool, { clientId: body.clientId, scopes: body.scopes,
            changeKey: body.changeKey, operatorUserId: actor });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return installationError(error); }
    })
    .post('/api/account/recovery-policy', {
      body: t.Object({ currentPassword: t.String({ minLength: 1, maxLength: 256 }),
        guardianEmail: t.String({ minLength: 3, maxLength: 320 }), recoveryCode,
        previousRecoveryCode: t.Optional(recoveryCode) },
      { additionalProperties: false }),
      response: { 200: t.Object({ generation: t.String(), replayed: t.Boolean() }),
        401: accountProblem, 403: accountProblem, 409: accountProblem, 503: accountProblem },
    }, async ({ request, body }) => {
      const actor = await accountActor(request);
      if (actor instanceof Response) return actor;
      try { await auth.api.verifyPassword({ headers: request.headers,
        body: { password: body.currentPassword } }); }
      catch { return Response.json({ error: 'recovery_denied' }, { status: 403 }); }
      try {
        return Response.json(await enrollAccountRecovery(pool, actor.userId, actor.sessionId,
          body.guardianEmail, body.recoveryCode, body.previousRecoveryCode),
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return recoveryError(error); }
    })
    .post('/api/account/recovery-claims', {
      body: t.Object({ claimId: recoveryId,
        targetEmail: t.String({ minLength: 3, maxLength: 320 }), recoveryCode },
      { additionalProperties: false }),
      response: { 200: recoveryView, 403: accountProblem,
        409: accountProblem, 503: accountProblem },
    }, async ({ request, body }) => {
      if (request.headers.get('origin') !== origin) {
        return Response.json({ error: 'invalid_origin' }, { status: 403 });
      }
      try { return Response.json(await requestAccountRecovery(pool, body),
        { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return recoveryError(error); }
    })
    .post('/api/account/recovery-claims/:claimId/read', {
      params: t.Object({ claimId: recoveryId }),
      body: t.Object({ recoveryCode }, { additionalProperties: false }),
      response: { 200: recoveryView, 403: accountProblem, 503: accountProblem },
    }, async ({ request, params, body }) => {
      if (request.headers.get('origin') !== origin) {
        return Response.json({ error: 'invalid_origin' }, { status: 403 });
      }
      try { return Response.json(await readAccountRecoveryClaim(pool,
        params.claimId, body.recoveryCode), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return recoveryError(error); }
    })
    .post('/api/account/recovery-claims/:claimId/approval', {
      params: t.Object({ claimId: recoveryId }),
      response: { 200: recoveryView, 401: accountProblem, 403: accountProblem,
        409: accountProblem, 503: accountProblem },
    }, async ({ request, params }) => {
      const guardian = await accountActor(request);
      if (guardian instanceof Response) return guardian;
      try { return Response.json(await approveAccountRecovery(pool, params.claimId,
        guardian.userId, guardian.sessionId),
        { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return recoveryError(error); }
    })
    .post('/api/account/recovery-claims/:claimId/activation', {
      params: t.Object({ claimId: recoveryId }),
      body: t.Object({ recoveryCode, newPassword: t.String({ minLength: 12, maxLength: 128 }) },
      { additionalProperties: false }),
      response: { 200: t.Object({ claimId: t.String(), recoveryGeneration: t.String(),
        replayed: t.Boolean() }), 403: accountProblem, 409: accountProblem,
        503: accountProblem },
    }, async ({ request, params, body }) => {
      if (request.headers.get('origin') !== origin) {
        return Response.json({ error: 'invalid_origin' }, { status: 403 });
      }
      try { return Response.json(await activateAccountRecovery(pool,
        { ...body, claimId: params.claimId, digestKey: String(auth.options.secret) }),
      { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return recoveryError(error); }
    })
    .cleanup(async () => { await guardPool?.end(); })
    .mount((request: Request) => observeAuthentication(auth, pool, request, () => guardedAuthHandler(request)));
  return app.get('/api/account/openapi.json', () => ({ openapi: '3.1.2',
    info: { title: 'REZICS Account API', version: '1' },
    ...toOpenAPISchema(app, { paths: [/^\/api\/auth\//, /^\/health\//, '/api/account/openapi.json'] }),
  }));
}

/** Import this type only in the Accounts site; never bundle the server module. */
export type AccountApp = ReturnType<typeof createAccountApp>;
