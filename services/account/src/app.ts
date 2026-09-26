import { Elysia, t } from 'elysia';
import { Pool } from 'pg';
import type { createAccountAuth } from './auth.ts';
import { currentInstallationIn, installClient, InstallationConflict, InstallationInvalid,
  InstallationNotFound, readInstallation, revokeInstallation } from './installations.ts';
import { currentIntrospection, presentedToken } from './introspection.ts';
import { guardedAuthorizationCodeExchange } from './oauth-code-guard.ts';

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

export function createAccountApp(auth: ReturnType<typeof createAccountAuth>, pool: Pool,
  options: AccountAppOptions = {}) {
  const operators = options.operatorUserIds ?? new Set<string>();
  const origin = new URL(String(auth.options.baseURL)).origin;
  // The guard holds its own bounded connections across a provider exchange,
  // which draws on the owner pool. Excess concurrent exchanges wait at most two
  // seconds for a guard connection, then fail as temporarily unavailable; they
  // never take the connections the exchange itself needs.
  let guardPool: Pool | undefined;
  const guard = () => guardPool ??= new Pool({ ...pool.options,
    max: options.codeGuardConnections ?? 4, connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 1_000, allowExitOnIdle: true });
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
    // The pinned provider lets update-consent widen scopes without the
    // authorization/consent round trip. This first profile admits edits only
    // through that explicit round trip, which advances the durable generation.
    .post('/api/auth/oauth2/update-consent', () =>
      Response.json({ error: 'unsupported_consent_update' }, { status: 403 }))
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
    .cleanup(async () => { await guardPool?.end(); })
    .mount(auth.handler);
}
