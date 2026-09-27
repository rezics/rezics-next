import { Elysia, t } from 'elysia';
import { Pool } from 'pg';
import type { createAccountAuth } from './auth.ts';
import { currentInstallationIn, installClient, InstallationConflict, InstallationInvalid,
  InstallationNotFound, readInstallation, revokeInstallation } from './installations.ts';
import { currentIntrospection, presentedToken } from './introspection.ts';
import { guardedAuthorizationCodeExchange } from './oauth-code-guard.ts';
import { consumeAccountLimit } from './rate-limit.ts';
import { consentApi } from './consent.ts';
import { methodsApi, requireStepUp, sensitiveAuthPaths } from './methods.ts';
import { accountFailure, accountSession } from './http.ts';
import { observeAuthentication, securityActivityApi } from './security-activity.ts';
import { connectedAppsApi } from './connected-apps.ts';
import { AccountRecoveryConflict, AccountRecoveryDenied, AccountRecoveryStale,
  activateAccountRecovery, approveAccountRecovery, enrollAccountRecovery,
  readAccountRecoveryClaim, requestAccountRecovery } from './recovery-claim.ts';

export interface AccountAppOptions {
  /** Verified private user IDs allowed to change App installations. */
  operatorUserIds?: ReadonlySet<string>;
  /** Connections the authorization-code guard may hold across exchanges. */
  codeGuardConnections?: number;
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
  const operators = options.operatorUserIds ?? new Set<string>();
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
    if (write && request.headers.get('origin') !== origin) {
      return Response.json({ error: 'invalid_origin' }, { status: 403 });
    }
    let session;
    try { session = await auth.api.getSession({ headers: request.headers }); }
    catch { return Response.json({ error: 'temporarily_unavailable' }, { status: 503 }); }
    if (!session) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    return operators.has(session.user.id) ? session.user.id
      : Response.json({ error: 'forbidden' }, { status: 403 });
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
  const credentialPaths = new Set(['/api/auth/change-password', '/api/auth/set-password',
    '/api/auth/change-email', '/api/auth/update-user',
    '/api/auth/link-social', '/api/auth/unlink-account']);
  const guardedAuthHandler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (sensitiveAuthPaths.has(path)) {
      try {
        const session = await accountSession(auth, request, true);
        await requireStepUp(pool, session);
        if (path === '/api/auth/passkey/delete-passkey') {
          const { id } = await request.clone().json() as { id?: string };
          const methods = await pool.query(`SELECT 1 FROM passkey WHERE "userId" = $1 AND id <> $2
            UNION ALL SELECT 1 FROM account WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL LIMIT 1`,
          [session.user.id, id ?? '']);
          if (!methods.rowCount) return Response.json({ error: 'last_sign_in_method' }, { status: 409 });
        }
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
  return new Elysia()
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
    .use(consentApi(auth, pool))
    .use(methodsApi(auth, pool))
    .use(securityActivityApi(auth, pool))
    .use(connectedAppsApi(auth, pool))
    .post('/api/auth/oauth2/token', ({ request }) =>
      guardedAuthorizationCodeExchange(guard(), request, () => auth.handler(request)))
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
      return auth.handler(request);
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
}
