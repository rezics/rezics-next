import { APIError } from 'better-auth/api';
import type { Pool, PoolClient } from 'pg';

export const SESSION_CLEANUP_PAGE_SIZE = 100;

/** One session and owner probe, independent of retained history. Natural browser
 * expiry is separate: a product offline family remains bound until sign-out. */
export async function sessionBasisActive(db: Pool | PoolClient, sessionId: string, userId?: string): Promise<boolean> {
  const current = await db.query(`SELECT 1 FROM "session" s JOIN rezics_account_security p ON p.user_id = s."userId"
    WHERE s.id = $1 AND ($2::text IS NULL OR s."userId" = $2)
      AND s.rezics_generation = p.session_generation`, [sessionId, userId ?? null]);
  return current.rowCount === 1;
}

type SessionSelection = { all: true } | { others: true } | { sessionId: string } | { sessionIds: string[] };

/** A bulk epoch change writes one owner row, with one current-session restamp
 * for revoke-other. Explicit selections have the existing 100-session cap.
 * Counts are exact when a 101-row probe proves that the inventory fits; larger
 * bulk selections report unknown rather than scanning the entire inventory. */
export async function revokeSessionSelection(pool: Pool, userId: string, currentId: string,
  selection: SessionSelection): Promise<{ revoked: number | null }> {
  if ('sessionIds' in selection && selection.sessionIds.length > SESSION_CLEANUP_PAGE_SIZE) {
    throw new APIError('BAD_REQUEST');
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const owner = await db.query<{ generation: string }>(`SELECT session_generation::text AS generation
      FROM rezics_account_security WHERE user_id = $1 FOR UPDATE`, [userId]);
    const generation = owner.rows[0]?.generation;
    const actor = await db.query(`SELECT 1 FROM "session" WHERE id = $1 AND "userId" = $2
      AND rezics_generation = $3 AND "expiresAt" > now() FOR UPDATE`, [currentId, userId, generation]);
    if (!generation || !actor.rowCount) throw new APIError('UNAUTHORIZED');
    let revoked: number | null;
    if ('all' in selection || 'others' in selection) {
      const preview = await db.query(`SELECT id FROM "session" WHERE "userId" = $1 AND rezics_generation = $2
        AND ($3::text IS NULL OR id <> $3) ORDER BY id LIMIT $4`,
      [userId, generation, 'others' in selection ? currentId : null, SESSION_CLEANUP_PAGE_SIZE + 1]);
      revoked = preview.rows.length > SESSION_CLEANUP_PAGE_SIZE ? null : preview.rows.length;
      if (revoked !== 0) {
        const next = await db.query<{ generation: string }>(`UPDATE rezics_account_security
          SET session_generation = session_generation + 1, session_cleanup_pending = true
          WHERE user_id = $1 RETURNING session_generation::text AS generation`, [userId]);
        if ('others' in selection) {
          await db.query('UPDATE "session" SET rezics_generation = $2 WHERE id = $1', [currentId, next.rows[0]!.generation]);
        }
      }
    } else {
      const ids = 'sessionId' in selection ? [selection.sessionId]
        : selection.sessionIds.filter(id => id !== currentId);
      const marked = await db.query(`UPDATE "session" SET rezics_generation = NULL
        WHERE "userId" = $1 AND id = ANY($2::text[]) AND rezics_generation = $3`, [userId, ids, generation]);
      revoked = marked.rowCount ?? 0;
      if (revoked) await db.query('UPDATE rezics_account_security SET session_cleanup_pending = true WHERE user_id = $1', [userId]);
    }
    if (revoked !== 0) await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
      VALUES ($1, 'session_revoked', $2::jsonb)`, [userId, JSON.stringify({ selection, revoked, phase: 'logical' })]);
    await db.query('COMMIT');
    return { revoked };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Provider automatic expiry/sign-out still runs its normal cookie cleanup.
 * Veto the destructive adapter DELETE: its FK fanout is retained for bounded
 * maintenance. The terminal marker is committed independently of that adapter. */
export async function beforeSessionDelete(pool: Pool, session: { id: string; userId: string },
  _context?: { path?: string } | null): Promise<false> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await db.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR UPDATE', [session.userId]);
    const marked = await db.query(`UPDATE "session" SET rezics_generation = NULL
      WHERE "userId" = $1 AND id = $2 AND rezics_generation IS NOT NULL`, [session.userId, session.id]);
    if (marked.rowCount) {
      await db.query('UPDATE rezics_account_security SET session_cleanup_pending = true WHERE user_id = $1', [session.userId]);
      await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
        VALUES ($1, 'session_revoked', $2::jsonb)`, [session.userId, JSON.stringify({ sessionId: session.id, phase: 'logical' })]);
    }
    await db.query('COMMIT');
    return false;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export type SessionCleanupPage = { userId?: string; sessions: number; accessTokens: number;
  refreshTokens: number; pendingConsents: number; pending: boolean };

/** One existing-owner maintenance continuation. At most 100 session candidates,
 * 100 writes per token/consent table, and one security row; no all-user session
 * scan or request drain. Lateral token probes cap retained history per candidate
 * too (100 candidates × 100 indexed rows), then the outer LIMIT caps writes.
 * Rows with remaining FK fanout keep their session link for a later tick. */
export async function cleanupRevokedSessionPage(pool: Pool): Promise<SessionCleanupPage> {
  const db = await pool.connect();
  const page: SessionCleanupPage = { sessions: 0, accessTokens: 0, refreshTokens: 0, pendingConsents: 0, pending: false };
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const claimed = await db.query<{ userId: string; generation: string }>(`SELECT user_id AS "userId",
      session_generation::text AS generation FROM rezics_account_security WHERE session_cleanup_pending
      ORDER BY user_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const owner = claimed.rows[0];
    if (!owner) { await db.query('COMMIT'); return page; }
    page.userId = owner.userId;
    const terminal = await db.query<{ id: string }>(`SELECT id FROM "session"
      WHERE "userId" = $1 AND rezics_generation IS NULL ORDER BY id LIMIT $2 FOR UPDATE`,
    [owner.userId, SESSION_CLEANUP_PAGE_SIZE]);
    const previous = terminal.rows.length === SESSION_CLEANUP_PAGE_SIZE ? [] : (await db.query<{ id: string }>(`SELECT id FROM "session"
      WHERE "userId" = $1 AND rezics_generation < $2 ORDER BY rezics_generation, id LIMIT $3 FOR UPDATE`,
    [owner.userId, owner.generation, SESSION_CLEANUP_PAGE_SIZE - terminal.rows.length])).rows;
    const ids = [...terminal.rows, ...previous].map(row => row.id);
    const access = await db.query(`WITH candidates AS (
      SELECT a.id FROM unnest($1::text[]) s(id) CROSS JOIN LATERAL (
        SELECT id FROM "oauthAccessToken" WHERE "sessionId" = s.id ORDER BY id LIMIT $2
      ) a LIMIT $2)
      UPDATE "oauthAccessToken" SET revoked = COALESCE(revoked, now()), "sessionId" = NULL, "refreshId" = NULL
      WHERE id IN (SELECT id FROM candidates)`, [ids, SESSION_CLEANUP_PAGE_SIZE]);
    page.accessTokens = access.rowCount ?? 0;
    const refresh = await db.query<{ id: string; firstParty: boolean; offline: boolean }>(`SELECT r.id,
      EXISTS (SELECT 1 FROM rezics_oauth_first_party_client fp WHERE fp.client_id = r."clientId") AS "firstParty",
      COALESCE(r.scopes, '[]'::jsonb) ? 'offline_access' AS offline
      FROM unnest($1::text[]) s(id) CROSS JOIN LATERAL (
        SELECT id, "clientId", scopes FROM "oauthRefreshToken" WHERE "sessionId" = s.id ORDER BY id LIMIT $2
      ) r LIMIT $2`, [ids, SESSION_CLEANUP_PAGE_SIZE]);
    const productIds = refresh.rows.filter(row => row.firstParty).map(row => row.id);
    // Clear remaining access refs in a separately capped remainder of this
    // page's access budget, before deleting their product refresh parent.
    if (page.accessTokens < SESSION_CLEANUP_PAGE_SIZE && productIds.length) {
      const refs = await db.query(`WITH candidates AS (
        SELECT a.id FROM unnest($1::text[]) r(id) CROSS JOIN LATERAL (
          SELECT id FROM "oauthAccessToken" WHERE "refreshId" = r.id ORDER BY id LIMIT $2
        ) a LIMIT $2)
        UPDATE "oauthAccessToken" SET revoked = COALESCE(revoked, now()), "sessionId" = NULL, "refreshId" = NULL
        WHERE id IN (SELECT id FROM candidates)`, [productIds, SESSION_CLEANUP_PAGE_SIZE - page.accessTokens]);
      page.accessTokens += refs.rowCount ?? 0;
    }
    const deleted = await db.query(`DELETE FROM "oauthRefreshToken" r WHERE id = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" a WHERE a."refreshId" = r.id)`, [productIds]);
    const external = refresh.rows.filter(row => !row.firstParty);
    const detached = await db.query(`UPDATE "oauthRefreshToken" SET "sessionId" = NULL,
      revoked = CASE WHEN COALESCE(scopes, '[]'::jsonb) ? 'offline_access' THEN revoked ELSE COALESCE(revoked, now()) END
      WHERE id = ANY($1::text[])`, [external.map(row => row.id)]);
    page.refreshTokens = (deleted.rowCount ?? 0) + (detached.rowCount ?? 0);
    const consents = await db.query(`WITH candidates AS (
      SELECT p.id FROM unnest($1::text[]) s(id) CROSS JOIN LATERAL (
        SELECT id FROM rezics_account_pending_consent WHERE session_id = s.id ORDER BY id LIMIT $2
      ) p LIMIT $2)
      DELETE FROM rezics_account_pending_consent WHERE id IN (SELECT id FROM candidates)`, [ids, SESSION_CLEANUP_PAGE_SIZE]);
    page.pendingConsents = consents.rowCount ?? 0;
    const sessions = await db.query(`DELETE FROM "session" s WHERE s.id = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" a WHERE a."sessionId" = s.id)
      AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" r WHERE r."sessionId" = s.id)
      AND NOT EXISTS (SELECT 1 FROM rezics_account_pending_consent p WHERE p.session_id = s.id)`, [ids]);
    page.sessions = sessions.rowCount ?? 0;
    // Remaining cascades are bounded: one step-up per session and one email
    // change per user. No token/consent SET NULL or delete fanout remains.
    const remaining = await db.query(`SELECT
      EXISTS (SELECT 1 FROM "session" WHERE "userId" = $1 AND rezics_generation IS NULL)
      OR EXISTS (SELECT 1 FROM "session" WHERE "userId" = $1 AND rezics_generation < $2) AS pending`,
    [owner.userId, owner.generation]);
    page.pending = remaining.rows[0].pending as boolean;
    await db.query('UPDATE rezics_account_security SET session_cleanup_pending = $2 WHERE user_id = $1', [owner.userId, page.pending]);
    await db.query('COMMIT');
    return page;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
