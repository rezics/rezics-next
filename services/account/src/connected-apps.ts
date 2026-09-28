import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { decodeCursor, encodeCursor, pageQuery } from './pagination.ts';
import { requireStepUp } from './methods.ts';
import { describeScope } from './scope-descriptions.ts';
import { accountResponses, connectedAppView, pageView, statusView } from './views.ts';

/** One indexed user-grant seek and bounded client/consent/installation probes;
 * no token scan or credential material. A consent or an issued first-party
 * grant represents the person's connection. Other skip-consent grants can be
 * issued by operator tooling on their behalf and are not connected apps. */
export async function readConnectedApps(pool: Pool, secret: string, userId: string,
  query: { limit?: number; cursor?: string } = {}) {
  const scope = `apps:${userId}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const limit = query.limit ?? 25;
  const result = await pool.query<{ clientId: string; name: string; uri: string | null; icon: string | null;
    scopes: string[]; grantedAt: Date; lastUsedAt: Date | null; installationId: string | null;
    installationState: string | null; trusted: boolean | null; firstParty: boolean; cursorKey: string }>(`SELECT g.client_id AS "clientId", coalesce(c.name, g.client_id) AS name, c.uri, c.icon,
      g.scopes, g.granted_at AS "grantedAt", g.last_used_at AS "lastUsedAt", c."skipConsent" AS trusted,
      fp.client_id IS NOT NULL AS "firstParty",
      g.granted_at::text AS "cursorKey",
      i.id AS "installationId", i.state AS "installationState"
    FROM rezics_account_grant g JOIN "oauthClient" c ON c."clientId" = g.client_id
    LEFT JOIN LATERAL (SELECT id, state FROM rezics_oauth_installation WHERE client_id = g.client_id
      ORDER BY installed_at DESC, id DESC LIMIT 1) i ON true
    LEFT JOIN rezics_oauth_first_party_client fp ON fp.client_id = g.client_id
    WHERE g.user_id = $1 AND g.revoked_at IS NULL
      AND (fp.client_id IS NOT NULL OR EXISTS (SELECT 1 FROM "oauthConsent" consent
        WHERE consent."userId" = g.user_id AND consent."clientId" = g.client_id))
      AND ($2::timestamptz IS NULL OR (g.granted_at, g.client_id) < ($2, $3))
    ORDER BY g.granted_at DESC, g.client_id DESC LIMIT $4`,
  [userId, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(({ cursorKey: _key, ...row }) => ({ ...row, trusted: !!row.trusted,
    scopes: row.scopes.map(describeScope), grantedAt: row.grantedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null })),
  nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.clientId) : null };
}

export async function revokeConnectedApp(pool: Pool, userId: string, clientId: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Same order as issuance: user fence, then grant fence, then token rows.
    await db.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR SHARE', [userId]);
    const result = await db.query(`UPDATE rezics_account_grant SET generation = generation + 1, revoked_at = now()
      WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL RETURNING user_id`, [userId, clientId]);
    if (!result.rowCount && !(await db.query('SELECT 1 FROM rezics_account_grant WHERE user_id = $1 AND client_id = $2',
      [userId, clientId])).rowCount) throw new AccountProblem('not_found', 404);
    await db.query('DELETE FROM "oauthConsent" WHERE "userId" = $1 AND "clientId" = $2', [userId, clientId]);
    await db.query('UPDATE "oauthRefreshToken" SET revoked = now() WHERE "userId" = $1 AND "clientId" = $2 AND revoked IS NULL',
      [userId, clientId]);
    if (result.rowCount) await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
      VALUES ($1, 'app_revoked', jsonb_build_object('clientId', $2::text))`, [userId, clientId]);
    await db.query('COMMIT');
    return { status: true as const };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export function connectedAppsApi(auth: AccountAuth, pool: Pool) {
  return new Elysia()
    .get('/api/account/connected-apps', { response: accountResponses(pageView(connectedAppView)), query: t.Object(pageQuery) }, async ({ request, query }) => {
      try { return accountJson(await readConnectedApps(pool, String(auth.options.secret),
        (await accountSession(auth, request)).user.id, query)); }
      catch (error) { return accountFailure(error); }
    })
    .post('/api/account/connected-apps/:clientId/revoke', {
      response: accountResponses(statusView),
      params: t.Object({ clientId: t.String({ minLength: 1, maxLength: 256 }) }),
    }, async ({ request, params }) => {
      try {
        const session = await accountSession(auth, request);
        await requireStepUp(pool, session);
        return accountJson(await revokeConnectedApp(pool, session.user.id, params.clientId));
      } catch (error) { return accountFailure(error); }
    });
}
