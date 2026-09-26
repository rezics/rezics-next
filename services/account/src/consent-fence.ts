import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { currentInstallationIn } from './installations.ts';

export const CONSENT_CLAIM = 'rezics_consent_id';
export const CONSENT_GENERATION_CLAIM = 'rezics_consent_generation';
export const AUTH_MODE_CLAIM = 'rezics_auth_mode';

export type CurrentCodeBasis = { installationId: string; recoveryGeneration: string } & ({ mode: 'trusted' }
  | { mode: 'consent'; consentId: string; generation: string });

/** The provider has consumed its verification row before claim contribution.
 * Its pinned hashed-token format is SHA-256/base64url; the DB trigger retained
 * the issuance basis under that identifier. A later consent edit or
 * installation change never changes what this code was allowed to mint. */
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
      generation: string | null; installationId: string | null;
      recoveryGeneration: string | null }>(`SELECT mode,
        consent_id AS "consentId", consent_generation::text AS generation,
        installation_id AS "installationId",
        recovery_generation::text AS "recoveryGeneration" FROM rezics_oauth_code_basis
        WHERE id = $1 AND client_id = $2 AND user_id = $3
          AND reference_id IS NOT DISTINCT FROM $4 AND expires_at > now()
        FOR SHARE`, [identifier, input.clientId, input.userId, input.referenceId ?? null]);
    const row = basis.rows[0];
    if (!row || !registration.rows[0] || !row.installationId || row.recoveryGeneration === null) {
      return null;
    }
    const recovery = await client.query<{ generation: string }>(`SELECT generation FROM
      public.rezics_account_recovery_policy WHERE id = $1 FOR SHARE`, [input.userId]);
    if (row.recoveryGeneration !== (recovery.rows[0]?.generation ?? '0')) return null;
    const installation = await currentInstallationIn(client, input.clientId, input.scopes);
    if (!installation?.covers || installation.id !== row.installationId) return null;
    const installationId = row.installationId;
    if (row.mode === 'trusted') {
      return registration.rows[0].skipConsent ? { mode: 'trusted', installationId,
        recoveryGeneration: row.recoveryGeneration } : null;
    }
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
    return consent.rowCount === 1 ? { mode: 'consent', installationId,
      recoveryGeneration: row.recoveryGeneration,
      consentId: row.consentId, generation: row.generation } : null;
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

const MIGRATION_DIRECTORY = new URL('../migrations/', import.meta.url);

/** Installed after Better Auth's pinned schema migration, before Account serves.
 * Every idempotent Account migration is reapplied in file-name order in one
 * transaction; numbered files may leave gaps. */
export async function installConsentRefreshFence(pool: Pool): Promise<void> {
  const sql = readdirSync(MIGRATION_DIRECTORY).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort().map(file => readFileSync(new URL(file, MIGRATION_DIRECTORY), 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const migration of sql) await client.query(migration);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve migration failure */ }
    throw error;
  } finally { client.release(); }
}

/** The signed issuance mode prevents a later client registration change from
 * reinterpreting an old consented token as trusted or workload. The JWT's
 * consent generation must still be current; no missing or stale basis is
 * active. Runs inside the caller's introspection transaction. */
export async function consentBasisActive(client: PoolClient,
  payload: Record<string, unknown>, clientId: string): Promise<boolean> {
  const registration = await client.query<{ skipConsent: boolean; grantTypes: string[];
    subjectType: string | null }>(
    'SELECT "skipConsent", "grantTypes", "subjectType" FROM "oauthClient" WHERE "clientId" = $1',
    [clientId]);
  const info = registration.rows[0];
  if (!info) return false;
  const mode = payload[AUTH_MODE_CLAIM];
  if (mode === 'workload') {
    return !!info.grantTypes?.includes('client_credentials') && payload.sub === clientId;
  }
  if (mode === 'trusted') return info.skipConsent;
  if (mode !== 'consent' || info.subjectType === 'pairwise') return false;
  const subject = payload.sub;
  const consentId = payload[CONSENT_CLAIM];
  const generation = payload[CONSENT_GENERATION_CLAIM];
  if (typeof subject !== 'string' || typeof consentId !== 'string'
    || typeof generation !== 'string') return false;
  const audience = (Array.isArray(payload.aud) ? payload.aud : [payload.aud])
    .filter((value): value is string => typeof value === 'string'
      && !value.endsWith('/oauth2/userinfo'));
  const consent = await client.query(`SELECT 1 FROM "oauthConsent"
    WHERE id = $1 AND "userId" = $2 AND "clientId" = $3
      AND "rezicsGeneration"::text = $4
      AND scopes @> to_jsonb($5::text[])
      AND (cardinality($6::text[]) = 0 OR resources @> to_jsonb($6::text[]))
    FOR SHARE`, [consentId, subject, clientId, generation, tokenScopes(payload), audience]);
  return consent.rowCount === 1;
}

export function tokenScopes(payload: Record<string, unknown>): string[] {
  return typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
}
