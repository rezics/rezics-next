import type { Pool, PoolClient } from 'pg';

/** Session-indexed token deletion with primary-key registry probes, proportional
 * to the selected sessions' retained tokens. Consented third-party offline
 * access outlives Account sign-out and is revoked through connected apps. */
export async function deleteFirstPartySessionTokens(db: PoolClient, userId: string, sessionIds: string[]) {
  // Delete retained rotations too: marking tokens revoked would trigger the
  // provider's user/client-wide reuse cleanup against other product sessions.
  await db.query(`DELETE FROM "oauthRefreshToken"
    WHERE "userId" = $1 AND "sessionId" = ANY($2::text[])
      AND "clientId" IN (SELECT client_id FROM rezics_oauth_first_party_client)`, [userId, sessionIds]);
}

/** Better Auth calls delete.before separately from its adapter DELETE. Finish
 * the database deletion here under one session lock so a concurrent refresh
 * cannot insert a replacement between token cleanup and ON DELETE SET NULL.
 * The provider's subsequent idempotent DELETE still runs its normal hooks and
 * cookie cleanup. One session probe and its bound first-party tokens; the
 * native revoke-all route scans only this user's sessions. Its provider hook
 * snapshot is capped at 100, so that route must select the complete user set. */
export async function beforeSessionDelete(pool: Pool, session: { id: string; userId: string },
  context: { path?: string } | null) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR SHARE', [session.userId]);
    const selected = context?.path === '/revoke-sessions'
      ? await db.query<{ id: string }>('SELECT id FROM "session" WHERE "userId" = $1 ORDER BY id FOR UPDATE', [session.userId])
      : await db.query<{ id: string }>('SELECT id FROM "session" WHERE "userId" = $1 AND id = $2 FOR UPDATE', [session.userId, session.id]);
    const ids = selected.rows.map(row => row.id);
    await deleteFirstPartySessionTokens(db, session.userId, ids);
    await db.query('DELETE FROM "session" WHERE "userId" = $1 AND id = ANY($2::text[])', [session.userId, ids]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
