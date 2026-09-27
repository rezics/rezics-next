import type { Pool, PoolClient } from 'pg';

export const ACCOUNT_GENERATION_CLAIM = 'rezics_account_generation';
export const GRANT_GENERATION_CLAIM = 'rezics_grant_generation';

/** Two indexed rows. Missing security state fails closed. */
export async function currentAccountGenerations(db: Pool | PoolClient, userId: string, clientId: string) {
  const result = await db.query<{ account: string; grant: string }>(`SELECT s.generation::text AS account,
    coalesce(g.generation, 0)::text AS grant FROM rezics_account_security s
    LEFT JOIN rezics_account_grant g ON g.user_id = s.user_id AND g.client_id = $2
    WHERE s.user_id = $1 AND NOT s.password_reset_required
      AND (s.suspended_at IS NULL OR s.suspended_until <= now())`, [userId, clientId]);
  return result.rows[0] ?? null;
}

export async function accountBasisActive(db: PoolClient, payload: Record<string, unknown>, clientId: string) {
  if (typeof payload.sub !== 'string') return false;
  const current = await currentAccountGenerations(db, payload.sub, clientId);
  if (!current || (payload[ACCOUNT_GENERATION_CLAIM] ?? '0') !== current.account
    || (payload[GRANT_GENERATION_CLAIM] ?? '0') !== current.grant) return false;
  // Record actual resource use at most once per minute. Never create or
  // resurrect a grant from introspection of a previously issued token.
  await db.query(`UPDATE rezics_account_grant SET last_used_at = now()
    WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL
      AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [payload.sub, clientId]);
  return true;
}
