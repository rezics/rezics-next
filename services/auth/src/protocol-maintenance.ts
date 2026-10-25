import type { Pool } from 'pg';

/** Expired native OAuth/OIDC state, access tokens before the refresh rows they
 * reference. A family expires with its newest token, and the provider refuses
 * any token whose family is missing, so removing a family never revives one. */
const expiring = [
  { table: '"oauthAccessToken"', expiry: '"expiresAt"', order: '"expiresAt", id' },
  { table: '"oauthRefreshToken"', expiry: '"expiresAt"', order: '"expiresAt", id' },
  { table: '"oauthRefreshFamily"', expiry: '"expiresAt"', order: '"expiresAt"' },
  { table: '"oauthClientAssertion"', expiry: '"expiresAt"', order: '"expiresAt", id' },
  { table: 'auth_recent_oidc_session', expiry: 'expires_at', order: 'expires_at, session_id' },
] as const;

// Same shape as verification expiry: probe at most 2B indexed candidates, lock
// and delete at most B with SKIP LOCKED and exact TIDs. Never drains history.
const statements = expiring.map(
  ({ table, expiry, order }) => `WITH candidates AS MATERIALIZED (
  SELECT ctid FROM ${table} WHERE ${expiry} < statement_timestamp() ORDER BY ${order} LIMIT $1 * 2
), expired AS MATERIALIZED (
  SELECT locked.ctid FROM candidates
  CROSS JOIN LATERAL (SELECT t.ctid FROM ${table} t WHERE t.ctid = candidates.ctid FOR UPDATE SKIP LOCKED) AS locked
  LIMIT $1
)
DELETE FROM ${table} WHERE ctid = ANY (ARRAY(SELECT ctid FROM expired))`,
);

/** One invocation, one bounded batch per kind. The caller schedules repeats. */
export async function pruneExpiredProtocolState(database: Pool, batch = 1000): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000) throw new RangeError('batch must be 1..1000');
  let removed = 0;
  for (const statement of statements) removed += (await database.query(statement, [batch])).rowCount ?? 0;
  return removed;
}
