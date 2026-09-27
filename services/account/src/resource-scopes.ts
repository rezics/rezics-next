import type { Pool } from 'pg';
import { resourceScopes } from './oauth-scopes.ts';

/** The OAuth provider writes Main's resource row once, so scopes installed by a
 * later release were silently dropped from every token (G-282's follow and
 * vote scopes on a stack prepared before it). Startup makes the stored ceiling
 * equal the installed scopes; a missing row is left for the provider to create. */
export async function reconcileResourceScopes(pool: Pick<Pool, 'query'>, resource: string,
  scopes: readonly string[] = resourceScopes): Promise<boolean> {
  const updated = await pool.query(`UPDATE "oauthResource"
    SET "allowedScopes" = $1::jsonb, "updatedAt" = now()
    WHERE identifier = $2 AND "allowedScopes" IS DISTINCT FROM $1::jsonb`, [JSON.stringify(scopes), resource]);
  return (updated.rowCount ?? 0) > 0;
}
