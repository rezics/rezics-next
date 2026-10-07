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

type SessionDeleteContext = { path?: string;
  context?: { session?: { session?: { id: string } } | null } };

// Native revoke-other invokes session hooks concurrently, while revoke-all
// invokes them sequentially. Drain only once per request in either case.
const bulkDeletes = new WeakMap<SessionDeleteContext, Promise<void>>();
const SESSION_PAGE_SIZE = 100;

/** Better Auth snapshots each session's OAuth rows before our delete hook, but
 * its bulk session sample stops at 100. Retire the complete selected page under
 * the session locks before any ON DELETE SET NULL loses the authored links.
 * Each commit covers at most 100 sessions and their indexed retained tokens;
 * keyset pagination uses the existing user/createdAt/id session index. The
 * subsequent provider DELETE and hooks remain idempotent, with no dispatch. */
export async function beforeSessionDelete(pool: Pool, session: { id: string; userId: string },
  context: SessionDeleteContext | null) {
  const bulk = context?.path === '/revoke-sessions' || context?.path === '/revoke-other-sessions';
  if (!bulk) return deleteSessionPages(pool, session, null);
  const currentId = context.path === '/revoke-other-sessions' ? context.context?.session?.session?.id : null;
  if (currentId === undefined) throw new Error('Current session is required to revoke other sessions');
  const pending = bulkDeletes.get(context);
  if (pending) return pending;
  const work = deleteSessionPages(pool, session, { currentId });
  bulkDeletes.set(context, work);
  try { await work; }
  catch (error) { bulkDeletes.delete(context); throw error; }
}

async function deleteSessionPages(pool: Pool, session: { id: string; userId: string },
  bulk: { currentId: string | null } | null) {
  const db = await pool.connect();
  let cursor: { id: string; createdAt: string } | undefined;
  try {
    do {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout = '2s'");
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR SHARE', [session.userId]);
      const selected = bulk
        ? await db.query<{ id: string; createdAt: string }>(`SELECT id, "createdAt"::text AS "createdAt" FROM "session"
          WHERE "userId" = $1 AND ($2::text IS NULL OR id <> $2)
            AND ($3::timestamptz IS NULL OR ("createdAt", id) < ($3, $4))
          ORDER BY "createdAt" DESC, id DESC LIMIT $5 FOR UPDATE`,
        [session.userId, bulk.currentId, cursor?.createdAt ?? null, cursor?.id ?? null, SESSION_PAGE_SIZE])
        : await db.query<{ id: string; createdAt: string }>(`SELECT id, "createdAt"::text AS "createdAt" FROM "session"
          WHERE "userId" = $1 AND id = $2 FOR UPDATE`, [session.userId, session.id]);
      const ids = selected.rows.map(row => row.id);
      // Match the provider's logout retirement while the links still exist,
      // including rows outside its per-session token sample. Consented external
      // offline refresh survives; never advance its account/grant/consent basis.
      await db.query(`UPDATE "oauthAccessToken" SET revoked = now()
        WHERE "userId" = $1 AND "sessionId" = ANY($2::text[]) AND revoked IS NULL`, [session.userId, ids]);
      await db.query(`UPDATE "oauthRefreshToken" SET revoked = now()
        WHERE "userId" = $1 AND "sessionId" = ANY($2::text[]) AND revoked IS NULL
          AND NOT COALESCE(scopes, '[]'::jsonb) ? 'offline_access'`, [session.userId, ids]);
      // Session UPDATE locks fence the FK writes of concurrent issuance and
      // rotation. Delete retained product rotations too, avoiding provider reuse
      // cleanup against another session of the same user/client.
      await deleteFirstPartySessionTokens(db, session.userId, ids);
      await db.query('DELETE FROM "session" WHERE "userId" = $1 AND id = ANY($2::text[])', [session.userId, ids]);
      await db.query('COMMIT');
      if (!bulk || selected.rows.length < SESSION_PAGE_SIZE) return;
      cursor = selected.rows.at(-1)!;
    } while (true);
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
