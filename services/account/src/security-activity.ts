import { isIP } from 'node:net';
import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountFailure, accountJson, accountSession, type AccountAuth } from './http.ts';
import { decodeCursor, encodeCursor, pageQuery } from './pagination.ts';
import { requireStepUp } from './methods.ts';

export function deviceLabel(userAgent?: string | null) {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Unknown browser';
  const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return { browser, platform, label: platform ? `${browser} · ${platform}` : browser };
}
export function coarseNetwork(ip?: string | null) {
  if (!ip) return null;
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(ip) === 6) {
    const [left, right = ''] = ip.split('::');
    const prefix = left ? left.split(':') : [];
    const suffix = right ? right.split(':') : [];
    const full = [...prefix, ...Array.from({ length: 8 - prefix.length - suffix.length }, () => '0'), ...suffix];
    return `${full.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

export async function securityEvent(pool: Pool, userId: string, action: string, detail: Record<string, unknown> = {}) {
  await pool.query('INSERT INTO rezics_account_security_event (user_id, action, detail) VALUES ($1, $2, $3)',
    [userId, action, JSON.stringify(detail)]);
}

/** Indexed seek, bounded page, plus at most 1000 recent failures for a capped
 * summary. The log never exposes raw IPs, user agents or session tokens. */
export async function readSecurityActivity(pool: Pool, secret: string, userId: string,
  query: { limit?: number; cursor?: string }) {
  const scope = `activity:${userId}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const limit = query.limit ?? 25;
  const result = await pool.query<{ id: string; action: string; detail: Record<string, unknown>; occurredAt: Date; cursorKey: string }>(`
    SELECT id, action, detail, occurred_at AS "occurredAt", occurred_at::text AS "cursorKey" FROM rezics_account_security_event
    WHERE user_id = $1 AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2, $3::uuid))
    ORDER BY occurred_at DESC, id DESC LIMIT $4`, [userId, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const failed = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM (
    SELECT 1 FROM rezics_account_security_event WHERE user_id = $1 AND action = 'sign_in_failed'
      AND occurred_at > now() - interval '24 hours' LIMIT 1000) recent`, [userId]);
  return { items: rows.map(({ cursorKey: _key, ...row }) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
    nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.id) : null,
    failedAttemptsLast24Hours: { count: failed.rows[0]!.count, capped: failed.rows[0]!.count === 1000 } };
}

export async function readSessions(pool: Pool, secret: string, userId: string, currentId: string,
  query: { limit?: number; cursor?: string } = {}) {
  const scope = `sessions:${userId}`;
  const cursor = decodeCursor(secret, scope, query.cursor);
  const limit = query.limit ?? 25;
  const result = await pool.query<{ id: string; createdAt: Date; updatedAt: Date; expiresAt: Date;
    userAgent: string | null; ipAddress: string | null; cursorKey: string }>(`SELECT id, "createdAt", "updatedAt", "expiresAt", "userAgent", "ipAddress", "createdAt"::text AS "cursorKey"
    FROM "session" WHERE "userId" = $1 AND "expiresAt" > now()
      AND ($2::timestamptz IS NULL OR ("createdAt", id) < ($2, $3))
    ORDER BY "createdAt" DESC, id DESC LIMIT $4`, [userId, cursor?.key ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    device: deviceLabel(row.userAgent), network: coarseNetwork(row.ipAddress), thisDevice: row.id === currentId })),
  nextCursor: result.rows.length > limit && last ? encodeCursor(secret, scope, last.cursorKey, last.id) : null };
}

export function securityActivityApi(auth: AccountAuth, pool: Pool) {
  const secret = String(auth.options.secret);
  return new Elysia()
    .get('/api/account/security-activity', { query: t.Object(pageQuery) }, async ({ request, query }) => {
      try { return accountJson(await readSecurityActivity(pool, secret, (await accountSession(auth, request)).user.id, query)); }
      catch (error) { return accountFailure(error); }
    })
    .get('/api/account/sessions', { query: t.Object(pageQuery) }, async ({ request, query }) => {
      try {
        const session = await accountSession(auth, request);
        return accountJson(await readSessions(pool, secret, session.user.id, session.session.id, query));
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/sessions/revoke', { body: t.Union([
      t.Object({ sessionId: t.String({ minLength: 1, maxLength: 128 }) }),
      t.Object({ others: t.Literal(true) }),
    ]) }, async ({ request, body }) => {
      try {
        const session = await accountSession(auth, request);
        await requireStepUp(pool, session);
        const result = 'sessionId' in body
          ? await pool.query('DELETE FROM "session" WHERE "userId" = $1 AND id = $2', [session.user.id, body.sessionId])
          : await pool.query('DELETE FROM "session" WHERE "userId" = $1 AND id <> $2', [session.user.id, session.session.id]);
        return accountJson({ revoked: result.rowCount ?? 0 });
      } catch (error) { return accountFailure(error); }
    });
}

/** The two-factor plugin issues a provisional session after a password; only
 * a response containing a usable session is a successful sign-in event. */
export async function observeAuthentication(auth: AccountAuth, pool: Pool, request: Request,
  handle: () => Promise<Response>): Promise<Response> {
  const path = new URL(request.url).pathname;
  const signingIn = ['/api/auth/sign-in/email', '/api/auth/passkey/verify-authentication',
    '/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-backup-code'].includes(path);
  const signingOut = path === '/api/auth/sign-out';
  if (!signingIn && !signingOut) return handle();
  const input = await request.clone().json().catch(() => ({})) as { email?: string };
  const before = await auth.api.getSession({ headers: request.headers });
  const response = await handle();
  const output = await response.clone().json().catch(() => null) as {
    user?: { id: string }; token?: string; session?: { id: string }; twoFactorRedirect?: boolean;
  } | null;
  if (signingOut && response.ok && before) await securityEvent(pool, before.user.id, 'sign_out');
  else if (signingIn && response.ok && output?.user && (output.token || output.session) && !output.twoFactorRedirect) {
    await securityEvent(pool, output.user.id, 'sign_in', { method: path.split('/').at(-1),
      device: deviceLabel(request.headers.get('user-agent')),
      network: coarseNetwork(request.headers.get('x-rezics-client-ip')) });
  } else if (signingIn && !response.ok && typeof input.email === 'string') {
    const user = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [input.email.toLowerCase()]);
    if (user.rows[0]) await securityEvent(pool, user.rows[0].id, 'sign_in_failed', { method: 'password' });
  }
  return response;
}
