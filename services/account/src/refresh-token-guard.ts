import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sessionBasisActive } from './first-party-session.ts';
import { decodeJwt } from 'jose';

type TokenRow = {
  id: string;
  userId: string;
  clientId: string;
  authorizationCodeId: string | null;
  referenceId: string | null;
  sessionId: string | null;
  firstParty: boolean;
  authMode: string | null;
  consentId: string | null;
  consentGeneration: string | null;
  installationId: string | null;
  recoveryGeneration: string | null;
  accountGeneration: string | null;
  grantGeneration: string | null;
  revoked: Date | null;
  rotatedAt: Date | null;
  scopes: string[];
  resources: string[] | null;
};

const tokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');
const invalidGrant = () => Response.json({ error: 'invalid_grant' }, { status: 400,
  headers: { 'cache-control': 'no-store' } });
const unavailable = () => Response.json({ error: 'temporarily_unavailable' }, { status: 503,
  headers: { 'cache-control': 'no-store' } });

/** Better Auth 1.7.5 caches a rotation response but returns it before its
 * claims hook or DB write guards run. This boundary serializes by the hashed
 * presented token across Account replicas, then checks the current family and
 * every mutable admission fence for both fresh and cached 200 responses.
 * Normal exchange reads use unique token and primary-key probes, O(1) in
 * retained tokens and accounts. Wrong-client reuse deletes the provider's
 * whole user/client family, O(family size). One guard connection is held per
 * exchange with a bounded connect and advisory-lock wait. */
export async function guardedRefreshTokenExchange(guardPool: Pool, request: Request,
  exchange: (request: Request) => Promise<Response>): Promise<Response> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  let grantType: unknown;
  let presented: unknown;
  let claimingClient: unknown;
  try {
    if (contentType === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams(await request.clone().text());
      if (form.getAll('grant_type').length > 1 || form.getAll('refresh_token').length > 1
        || form.getAll('client_id').length > 1) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      grantType = form.get('grant_type');
      presented = form.get('refresh_token');
      claimingClient = form.get('client_id');
    } else if (contentType === 'application/json') {
      const body = await request.clone().json() as Record<string, unknown> | null;
      grantType = body?.grant_type;
      presented = body?.refresh_token;
      claimingClient = body?.client_id;
    } else return exchange(request);
  } catch { return exchange(request); }
  if (grantType !== 'refresh_token' || typeof presented !== 'string' || !presented) {
    return exchange(request);
  }
  const basic = request.headers.get('authorization')?.match(/^Basic +([^ ]+)$/i)?.[1];
  if (basic) {
    try { claimingClient = decodeURIComponent(Buffer.from(basic, 'base64').toString().split(':', 1)[0]!); }
    catch { claimingClient = undefined; }
  }
  const hash = tokenHash(presented);
  const rotationRequest = request.clone();
  let client;
  try { client = await guardPool.connect(); }
  catch { return unavailable(); }
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '8000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [hash]);
    // Take the owner lock before provider rotation locks its token row. This
    // gives the existing HTTP boundary the same order as bounded maintenance.
    const owner = (await client.query<{ userId: string }>(`SELECT "userId" AS "userId"
      FROM "oauthRefreshToken" WHERE token = $1`, [hash])).rows[0];
    if (owner) await client.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR SHARE', [owner.userId]);
    let response = await exchange(request);
    if (!response.ok) {
      if (typeof claimingClient === 'string' && claimingClient) {
        if (await revokeMismatchedFamily(client, hash, claimingClient)) {
          await client.query('COMMIT');
          committed = true;
        }
      }
      return response;
    }
    let body = await response.clone().json() as { access_token?: unknown; refresh_token?: unknown };
    if (typeof body.refresh_token !== 'string') return unavailable();
    let sourceHash = hash;
    const token = await tokenRow(client, hash);
    let accessSession: unknown;
    try { if (typeof body.access_token === 'string') accessSession = decodeJwt(body.access_token).sid; }
    catch { /* opaque access has no JWT session claim */ }
    if (token && !token.firstParty && token.scopes.includes('offline_access') && typeof accessSession === 'string'
      && !await sessionBasisActive(client, accessSession, token.userId)) {
      // A grace replay may carry the pre-sign-out JWT even though its retained
      // child is deliberately detached. Recover through exactly one ordinary
      // child rotation, under that child's existing advisory fence too.
      sourceHash = tokenHash(body.refresh_token);
      if (sourceHash === hash) return invalidGrant();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sourceHash]);
      // The provider will UPDATE this child on another connection. Its
      // advisory/owner fences suffice here; retain token-row locks only after
      // exchange, or a preflight SHARE lock would block our own rotation.
      if (!await liveRotation(client, hash, sourceHash, false)) return invalidGrant();
      response = await exchange(await detachedRotationRequest(rotationRequest, body.refresh_token));
      if (!response.ok) return response;
      body = await response.clone().json() as { access_token?: unknown; refresh_token?: unknown };
      if (typeof body.refresh_token !== 'string') return unavailable();
    }
    return await liveRotation(client, sourceHash, tokenHash(body.refresh_token)) ? response : invalidGrant();
  } catch { return unavailable(); }
  finally {
    if (!committed) try { await client.query('ROLLBACK'); } catch { /* preserve the response */ }
    client.release();
  }
}

async function detachedRotationRequest(request: Request, child: string): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  let body: string;
  if (headers.get('content-type')?.split(';', 1)[0]?.trim() === 'application/json') {
    body = JSON.stringify({ ...await request.clone().json() as Record<string, unknown>, refresh_token: child });
  } else {
    const form = new URLSearchParams(await request.clone().text());
    form.set('refresh_token', child);
    body = form.toString();
  }
  return new Request(request.url, { method: request.method, headers, body });
}

/** Better Auth rejects a mismatched client before its reuse detector runs.
 * A token presented by another registered client consumes the same family as
 * late reuse. Both deletes use the provider's user/client family boundary. */
async function revokeMismatchedFamily(client: PoolClient, hash: string,
  claimingClient: string): Promise<boolean> {
  const token = await client.query<{ userId: string; clientId: string;
    sessionId: string | null; firstParty: boolean }>(`SELECT r."userId" AS "userId",
    r."clientId" AS "clientId", r."sessionId" AS "sessionId",
    EXISTS (SELECT 1 FROM rezics_oauth_first_party_client fp WHERE fp.client_id = r."clientId") AS "firstParty"
    FROM public."oauthRefreshToken" r WHERE token = $1`, [hash]);
  const owner = token.rows[0];
  if (!owner || owner.clientId === claimingClient) return false;
  // Logical session retirement makes retained product refresh rows absent to
  // the provider. Keep that same boundary here so an old token cannot consume
  // the current session's still-admitted user/client family during cleanup.
  if (owner.firstParty && (!owner.sessionId
    || !await sessionBasisActive(client, owner.sessionId, owner.userId))) return false;
  const registration = await client.query(`SELECT 1 FROM public."oauthClient"
    WHERE "clientId" = $1 AND disabled = false`, [claimingClient]);
  if (!registration.rowCount) return false;
  await client.query(`DELETE FROM public."oauthAccessToken" WHERE "refreshId" IN (
    SELECT id FROM public."oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2)`,
  [owner.userId, owner.clientId]);
  await client.query(`DELETE FROM public."oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2`,
    [owner.userId, owner.clientId]);
  return true;
}

async function tokenRow(client: PoolClient, hash: string, holdRow = true): Promise<TokenRow | undefined> {
  const result = await client.query<TokenRow>(`SELECT id, "userId" AS "userId",
    "clientId" AS "clientId", "authorizationCodeId" AS "authorizationCodeId",
    "referenceId" AS "referenceId", "sessionId" AS "sessionId",
    "rezicsAuthMode" AS "authMode", "rezicsConsentId" AS "consentId",
    "rezicsConsentGeneration"::text AS "consentGeneration",
    "rezicsInstallationId" AS "installationId",
    "rezicsRecoveryGeneration"::text AS "recoveryGeneration",
    "rezicsAccountGeneration"::text AS "accountGeneration",
    "rezicsGrantGeneration"::text AS "grantGeneration",
    revoked, "rotatedAt" AS "rotatedAt", scopes, resources,
    EXISTS (SELECT 1 FROM rezics_oauth_first_party_client fp WHERE fp.client_id = r."clientId") AS "firstParty"
    FROM public."oauthRefreshToken" r WHERE token = $1 ${holdRow ? 'FOR SHARE' : ''}`, [hash]);
  const token = result.rows[0];
  // The provider projects a stale external offline link as detached before
  // maintenance reaches it. Compare that same basis for fresh/cache responses.
  if (token?.sessionId && !token.firstParty && token.scopes.includes('offline_access')
    && !await sessionBasisActive(client, token.sessionId, token.userId)) token.sessionId = null;
  return token;
}

async function liveRotation(client: PoolClient, oldHash: string,
  newHash: string, holdRows = true): Promise<boolean> {
  const old = await tokenRow(client, oldHash, holdRows);
  if (!old?.revoked || !old.rotatedAt || !old.authorizationCodeId) return false;
  const current = await tokenRow(client, newHash, holdRows);
  if (!current || current.revoked || current.id === old.id
    || current.userId !== old.userId || current.clientId !== old.clientId
    || current.authorizationCodeId !== old.authorizationCodeId
    || current.referenceId !== old.referenceId || current.sessionId !== old.sessionId
    || current.authMode !== old.authMode || current.consentId !== old.consentId
    || current.consentGeneration !== old.consentGeneration
    || current.installationId !== old.installationId
    || current.recoveryGeneration !== old.recoveryGeneration
    || current.accountGeneration !== old.accountGeneration
    || current.grantGeneration !== old.grantGeneration) return false;

  const registration = await client.query<{ skipConsent: boolean }>(`SELECT "skipConsent"
    FROM public."oauthClient" WHERE "clientId" = $1 AND disabled = false FOR SHARE`,
  [current.clientId]);
  if (!registration.rows[0]) return false;
  const security = await client.query<{ generation: string }>(`SELECT generation::text AS generation
    FROM public.rezics_account_security WHERE user_id = $1 AND deletion_started_at IS NULL
      AND NOT password_reset_required AND (suspended_at IS NULL OR suspended_until <= now())
    FOR SHARE`, [current.userId]);
  if (!security.rows[0] || security.rows[0].generation !== current.accountGeneration) return false;
  // Under the existing security share lock, a concurrent session epoch change
  // either committed before this probe or waits until this response decision.
  if ((current.firstParty || !current.scopes.includes('offline_access'))
    && (!current.sessionId || !await sessionBasisActive(client, current.sessionId, current.userId))) return false;
  const grant = await client.query<{ generation: string; revoked: boolean }>(`SELECT
    generation::text AS generation, revoked_at IS NOT NULL AS revoked
    FROM public.rezics_account_grant WHERE user_id = $1 AND client_id = $2 FOR SHARE`,
  [current.userId, current.clientId]);
  if ((grant.rows[0]?.generation ?? '0') !== current.grantGeneration
    || grant.rows[0]?.revoked) return false;
  const recovery = await client.query<{ generation: string }>(`SELECT generation::text AS generation
    FROM public.rezics_account_recovery_policy WHERE id = $1 FOR SHARE`, [current.userId]);
  if ((recovery.rows[0]?.generation ?? '0') !== current.recoveryGeneration) return false;
  const installation = await client.query(`SELECT 1 FROM public.rezics_oauth_installation
    WHERE id = $1 AND client_id = $2 AND state = 'active' AND scopes @> to_jsonb($3::text[])
    FOR SHARE`, [current.installationId, current.clientId, current.scopes]);
  if (!installation.rowCount) return false;
  if (current.authMode === 'trusted') return registration.rows[0].skipConsent;
  if (current.authMode !== 'consent' || registration.rows[0].skipConsent) return false;
  const consent = await client.query(`SELECT 1 FROM public."oauthConsent"
    WHERE id = $1 AND "userId" = $2 AND "clientId" = $3
      AND "referenceId" IS NOT DISTINCT FROM $4 AND "rezicsGeneration"::text = $5
      AND scopes @> to_jsonb($6::text[])
      AND ($7::text[] IS NULL OR COALESCE(resources, '[]'::jsonb) @> to_jsonb($7::text[]))
    FOR SHARE`, [current.consentId, current.userId, current.clientId,
    current.referenceId, current.consentGeneration, current.scopes, current.resources]);
  return consent.rowCount === 1;
}
