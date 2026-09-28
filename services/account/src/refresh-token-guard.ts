import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type TokenRow = {
  id: string;
  userId: string;
  clientId: string;
  authorizationCodeId: string | null;
  referenceId: string | null;
  sessionId: string | null;
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
  exchange: () => Promise<Response>): Promise<Response> {
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
    } else return exchange();
  } catch { return exchange(); }
  if (grantType !== 'refresh_token' || typeof presented !== 'string' || !presented) {
    return exchange();
  }
  const basic = request.headers.get('authorization')?.match(/^Basic +([^ ]+)$/i)?.[1];
  if (basic) {
    try { claimingClient = decodeURIComponent(Buffer.from(basic, 'base64').toString().split(':', 1)[0]!); }
    catch { claimingClient = undefined; }
  }
  const hash = tokenHash(presented);
  let client;
  try { client = await guardPool.connect(); }
  catch { return unavailable(); }
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '8000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [hash]);
    const response = await exchange();
    if (!response.ok) {
      if (typeof claimingClient === 'string' && claimingClient) {
        if (await revokeMismatchedFamily(client, hash, claimingClient)) {
          await client.query('COMMIT');
          committed = true;
        }
      }
      return response;
    }
    const body = await response.clone().json() as { refresh_token?: unknown };
    if (typeof body.refresh_token !== 'string') return unavailable();
    return await liveRotation(client, hash, tokenHash(body.refresh_token)) ? response : invalidGrant();
  } catch { return unavailable(); }
  finally {
    if (!committed) try { await client.query('ROLLBACK'); } catch { /* preserve the response */ }
    client.release();
  }
}

/** Better Auth rejects a mismatched client before its reuse detector runs.
 * A token presented by another registered client consumes the same family as
 * late reuse. Both deletes use the provider's user/client family boundary. */
async function revokeMismatchedFamily(client: PoolClient, hash: string,
  claimingClient: string): Promise<boolean> {
  const token = await client.query<{ userId: string; clientId: string }>(`SELECT "userId" AS "userId",
    "clientId" AS "clientId" FROM public."oauthRefreshToken" WHERE token = $1`, [hash]);
  const owner = token.rows[0];
  if (!owner || owner.clientId === claimingClient) return false;
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

async function tokenRow(client: PoolClient, hash: string): Promise<TokenRow | undefined> {
  const result = await client.query<TokenRow>(`SELECT id, "userId" AS "userId",
    "clientId" AS "clientId", "authorizationCodeId" AS "authorizationCodeId",
    "referenceId" AS "referenceId", "sessionId" AS "sessionId",
    "rezicsAuthMode" AS "authMode", "rezicsConsentId" AS "consentId",
    "rezicsConsentGeneration"::text AS "consentGeneration",
    "rezicsInstallationId" AS "installationId",
    "rezicsRecoveryGeneration"::text AS "recoveryGeneration",
    "rezicsAccountGeneration"::text AS "accountGeneration",
    "rezicsGrantGeneration"::text AS "grantGeneration",
    revoked, "rotatedAt" AS "rotatedAt", scopes, resources
    FROM public."oauthRefreshToken" WHERE token = $1 FOR SHARE`, [hash]);
  return result.rows[0];
}

async function liveRotation(client: PoolClient, oldHash: string,
  newHash: string): Promise<boolean> {
  const old = await tokenRow(client, oldHash);
  if (!old?.revoked || !old.rotatedAt || !old.authorizationCodeId) return false;
  const current = await tokenRow(client, newHash);
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
