import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export const CONSENT_CLAIM = 'rezics_consent_id';
export const CONSENT_GENERATION_CLAIM = 'rezics_consent_generation';
export const AUTH_MODE_CLAIM = 'rezics_auth_mode';

export type CurrentCodeBasis = { mode: 'trusted' }
  | { mode: 'consent'; consentId: string; generation: string };

/** The provider has consumed its verification row before claim contribution.
 * Its pinned hashed-token format is SHA-256/base64url; the DB trigger retained
 * the issuance basis under that identifier. A later consent edit never changes
 * what this code was allowed to mint. */
export async function currentAuthorizationCodeBasis(pool: Pool, input: {
  code: string;
  clientId: string;
  userId: string;
  referenceId?: string;
  scopes: string[];
  resources?: string[];
}): Promise<CurrentCodeBasis | null> {
  const identifier = createHash('sha256').update(input.code).digest('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const registration = await client.query<{ skipConsent: boolean }>(
      'SELECT "skipConsent" FROM "oauthClient" WHERE "clientId" = $1 FOR SHARE',
      [input.clientId]);
    const basis = await client.query<{ mode: string; consentId: string | null;
      generation: string | null }>(`SELECT mode, consent_id AS "consentId",
        consent_generation::text AS generation FROM rezics_oauth_code_basis
        WHERE id = $1 AND client_id = $2 AND user_id = $3
          AND reference_id IS NOT DISTINCT FROM $4 AND expires_at > now()
        FOR SHARE`, [identifier, input.clientId, input.userId, input.referenceId ?? null]);
    const row = basis.rows[0];
    if (!row || !registration.rows[0]) return null;
    if (row.mode === 'trusted') return registration.rows[0].skipConsent ? { mode: 'trusted' } : null;
    if (row.mode !== 'consent' || registration.rows[0].skipConsent
      || !row.consentId || !row.generation) return null;
    const consent = await client.query(`SELECT 1 FROM "oauthConsent"
      WHERE id = $1 AND "rezicsGeneration"::text = $2
        AND "userId" = $3 AND "clientId" = $4
        AND "referenceId" IS NOT DISTINCT FROM $5
        AND scopes @> to_jsonb($6::text[])
        AND (cardinality($7::text[]) = 0 OR resources @> to_jsonb($7::text[]))
      FOR SHARE`, [row.consentId, row.generation, input.userId, input.clientId,
      input.referenceId ?? null, input.scopes, input.resources ?? []]);
    return consent.rowCount === 1
      ? { mode: 'consent', consentId: row.consentId, generation: row.generation } : null;
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

/** Installed after Better Auth's pinned schema migration, before Account serves. */
export async function installConsentRefreshFence(pool: Pool): Promise<void> {
  const sql = readFileSync(new URL('../migrations/001_consent_refresh_fence.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve migration failure */ }
    throw error;
  } finally { client.release(); }
}

/** The provider authenticates the introspection caller and token first. This
 * second decision makes the signed JWT's consent generation current at the
 * resource boundary; no missing or stale basis becomes active. */
export async function currentConsentIntrospection(pool: Pool, provider: Response): Promise<Response> {
  if (!provider.ok) return provider;
  let payload: Record<string, unknown>;
  try { payload = await provider.clone().json() as Record<string, unknown>; }
  catch { return new Response(null, { status: 503 }); }
  if (payload.active !== true) return provider;
  const clientId = payload.client_id;
  if (typeof clientId !== 'string') return inactive();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const registration = await client.query<{ skipConsent: boolean; grantTypes: string[];
        subjectType: string | null }>(
        'SELECT "skipConsent", "grantTypes", "subjectType" FROM "oauthClient" WHERE "clientId" = $1',
        [clientId]);
      const info = registration.rows[0];
      if (!info) return inactive();
      const mode = payload[AUTH_MODE_CLAIM];
      // The signed issuance mode prevents a later client registration change
      // from reinterpreting an old consented token as trusted or workload.
      if (mode === 'workload') {
        return info.grantTypes?.includes('client_credentials') && payload.sub === clientId
          ? provider : inactive();
      }
      if (mode === 'trusted') return info.skipConsent ? provider : inactive();
      if (mode !== 'consent') return inactive();
      if (info.subjectType === 'pairwise') return inactive();
      // The pinned provider re-derives custom claims on opaque introspection,
      // which loses the issuance generation. Its JWTs carry a signed jti;
      // reject opaque tokens for this first explicit-consent profile.
      if (typeof payload.jti !== 'string') return inactive();
      const subject = payload.sub;
      const consentId = payload[CONSENT_CLAIM];
      const generation = payload[CONSENT_GENERATION_CLAIM];
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
      const audience = (Array.isArray(payload.aud) ? payload.aud : [payload.aud])
        .filter((value): value is string => typeof value === 'string'
          && !value.endsWith('/oauth2/userinfo'));
      if (typeof subject !== 'string' || typeof consentId !== 'string'
        || typeof generation !== 'string') return inactive();
      const consent = await client.query(`SELECT 1 FROM "oauthConsent"
        WHERE id = $1 AND "userId" = $2 AND "clientId" = $3
          AND "rezicsGeneration"::text = $4
          AND scopes @> to_jsonb($5::text[])
          AND (cardinality($6::text[]) = 0 OR resources @> to_jsonb($6::text[]))
        FOR SHARE`, [consentId, subject, clientId, generation, scopes, audience]);
      return consent.rowCount === 1 ? provider : inactive();
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  } catch {
    return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

function inactive(): Response {
  return Response.json({ active: false }, { headers: { 'cache-control': 'no-store' } });
}
