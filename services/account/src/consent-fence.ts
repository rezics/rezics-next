import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export const CONSENT_CLAIM = 'rezics_consent_id';
export const CONSENT_GENERATION_CLAIM = 'rezics_consent_generation';
export const AUTH_MODE_CLAIM = 'rezics_auth_mode';

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
          AND scopes @> $5::text[]
          AND (cardinality($6::text[]) = 0 OR resources @> $6::text[])
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
