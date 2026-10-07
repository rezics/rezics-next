import { createHash } from 'node:crypto';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { currentInstallationIn } from './installations.ts';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { consentScopes } from './oauth-scopes.ts';
import { describeScope } from './scope-descriptions.ts';
import { accountResponses, consentDecisionView, consentView } from './views.ts';

type ConsentDecisionBody = { oauth_query?: unknown; accept?: unknown; scope?: unknown };

/** A third party that accepts without naming scopes grants only the scopes
 * the screen offered. An empty offer is a refusal: the provider treats ""
 * as a scope token and rejects it. First-party decisions stay unchanged. */
export function thirdPartyConsentDecision(
  body: ConsentDecisionBody, offered: readonly string[], thirdParty: boolean,
): ConsentDecisionBody {
  if (!thirdParty || body.accept !== true || body.scope !== undefined) return body;
  if (offered.length === 0) return { ...body, accept: false };
  return { ...body, scope: offered.join(' ') };
}

const canonicalQuery = (query: URLSearchParams) => new URLSearchParams([...query.entries()]
  .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)).toString();

/** 1.7.5 signs sorted key/value pairs with Better Auth makeSignature. Its
 * verifier is not exported (the rolling docs describe a later export).
 * Keep this version-bound adapter covered by real provider redirects. */
async function verifyConsentQuery(signed: string, secret: string) {
  const query = new URLSearchParams(signed);
  const signature = query.get('sig');
  const expiry = Number(query.get('exp'));
  if (query.getAll('sig').length !== 1 || !signature || !Number.isSafeInteger(expiry)
    || expiry * 1000 <= Date.now()) return false;
  query.delete('sig');
  return constantTimeEqual(signature, await makeSignature(canonicalQuery(query), secret));
}

export function consentApi(auth: AccountAuth, pool: Pool) {
  // The signed provider query is the authority. No client name, scope or
  // redirect supplied independently by a browser becomes a pending request.
  const pending = async (request: Request, signed: string) => {
    const session = await accountSession(auth, request);
    if (!await verifyConsentQuery(signed, (await auth.$context).secret)) {
      throw new AccountProblem('stale_request', 409);
    }
    const query = new URLSearchParams(signed);
    for (const key of ['client_id', 'scope', 'redirect_uri', 'state', 'exp']) {
      if (query.getAll(key).length !== 1 || !query.get(key)) throw new AccountProblem('invalid_request', 400);
    }
    const clientId = query.get('client_id')!;
    const scopes = query.get('scope')!.split(' ').filter(Boolean);
    const installation = await currentInstallationIn(pool, clientId, scopes);
    if (!installation?.covers) throw new AccountProblem('stale_request', 409);
    const registration = await pool.query<{ name: string; uri: string | null; icon: string | null;
      disabled: boolean | null; redirectUris: string[]; firstParty: boolean }>(
      `SELECT name, uri, icon, disabled, "redirectUris", EXISTS (SELECT 1 FROM rezics_oauth_first_party_client
        WHERE client_id = $1) AS "firstParty" FROM "oauthClient" WHERE "clientId" = $1`, [clientId]);
    const client = registration.rows[0];
    if (!client || client.disabled || !client.redirectUris.includes(query.get('redirect_uri')!)) {
      throw new AccountProblem('stale_request', 409);
    }
    const offered = consentScopes(scopes, client.firstParty);
    const id = createHash('sha256').update(canonicalQuery(query)).digest('hex');
    const expiry = new Date(Number(query.get('exp')) * 1000);
    await pool.query(`INSERT INTO rezics_account_pending_consent
      (id, session_id, installation_id, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [id, session.session.id, installation.id, expiry]);
    const current = await pool.query(`SELECT 1 FROM rezics_account_pending_consent
      WHERE id = $1 AND session_id = $2 AND installation_id = $3
        AND expires_at > now() AND decided_at IS NULL`, [id, session.session.id, installation.id]);
    if (!current.rowCount) throw new AccountProblem('stale_request', 409);
    const redirect = new URL(query.get('redirect_uri')!);
    return { id, session, installation, view: { client: { id: clientId, name: client.name || clientId,
      uri: client.uri, icon: client.icon, unverified: !client.firstParty,
      redirectHost: redirect.host || redirect.protocol }, scopes: offered.map(describeScope),
    resources: query.getAll('resource'), expiresAt: expiry.toISOString() } };
  };
  const decide = async (request: Request, parsed?: unknown): Promise<Response> => {
    try {
      const body = (parsed ?? await request.clone().json()) as { oauth_query?: unknown; accept?: unknown; scope?: unknown };
      if (typeof body.oauth_query !== 'string') throw new AccountProblem('forbidden', 403);
      if (body.oauth_query.length > 16_384 || typeof body.accept !== 'boolean') {
        throw new AccountProblem('invalid_request', 400);
      }
      const current = await pending(request, body.oauth_query);
      if (body.scope !== undefined && (typeof body.scope !== 'string'
        || !body.scope.split(' ').every(scope => current.view.scopes.some(item => item.scope === scope)))) {
        throw new AccountProblem('invalid_request', 400);
      }
      // Claim once before invoking the provider: a replay or concurrent click
      // cannot issue a second code. An interrupted decision starts a new flow.
      const claimed = await pool.query(`UPDATE rezics_account_pending_consent SET decided_at = now()
        WHERE id = $1 AND session_id = $2 AND decided_at IS NULL AND expires_at > now() RETURNING id`,
      [current.id, current.session.session.id]);
      if (!claimed.rowCount) throw new AccountProblem('stale_request', 409);
      const decision = thirdPartyConsentDecision(body,
        current.view.scopes.map(item => item.scope), current.view.client.unverified);
      return auth.handler(new Request(new URL('/api/auth/oauth2/consent', request.url), {
        method: 'POST', headers: request.headers, body: JSON.stringify(decision),
      }));
    } catch (error) { return accountFailure(error); }
  };
  const routes = new Elysia()
    .get('/api/account/consent', { query: t.Object({ oauth_query: t.String({ minLength: 1, maxLength: 16_384 }) }), response: accountResponses(consentView) },
      async ({ request, query }) => {
        try { return accountJson((await pending(request, query.oauth_query)).view); }
        catch (error) { return accountFailure(error); }
      })
    .post('/api/account/consent', { response: accountResponses(consentDecisionView), body: t.Object({ oauth_query: t.String({ minLength: 1, maxLength: 16_384 }),
      accept: t.Boolean(), scope: t.Optional(t.String({ maxLength: 4096 })) }) }, ({ request, body }) => decide(request, body))
    .post('/api/auth/oauth2/consent', ({ request, body }) => decide(request, body))
    .post('/api/auth/oauth2/update-consent', ({ request, body }) => decide(request, body));
  return routes;
}
