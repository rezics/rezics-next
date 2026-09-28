import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { accountFailure, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { readConnectedApps } from './connected-apps.ts';
import { readDisplayPreferences } from './display-preferences.ts';
import { readMethods, requireStepUp } from './methods.ts';
import { consumeAccountLimit } from './rate-limit.ts';
import { coarseNetwork, deviceLabel, readSessions, securityEvent } from './security-activity.ts';
import { accountExportView, accountResponses } from './views.ts';

/** Rows per section. A person has far fewer devices and Apps; the activity
 * cap keeps a scripted account's archive to a few megabytes. */
export const exportCaps = { devices: 500, apps: 500, events: 5_000 } as const;

/**
 * Everything Account holds about one person, as one JSON archive: profile,
 * display preferences, sign-in methods (names and dates, never keys or
 * secrets), signed-in devices, connected Apps and security activity.
 * Staff notes and the operator audit are staff records and stay out.
 *
 * Cost: one primary-key profile read, the bounded method reads, and one
 * indexed seek each for devices, Apps and events (`exportCaps` + 1 rows);
 * no cross-user scan.
 */
export async function exportAccountData(pool: Pool, secret: string, userId: string, sessionId: string) {
  const profile = await pool.query<{ id: string; name: string; email: string; emailVerified: boolean;
    image: string | null; locale: string | null; createdAt: Date; updatedAt: Date }>(`SELECT id, name, email,
      "emailVerified", image, locale, "createdAt", "updatedAt" FROM "user" WHERE id = $1`, [userId]);
  const account = profile.rows[0];
  if (!account) throw new AccountProblem('not_found', 404);
  const [preferences, methods, devices, apps, events] = await Promise.all([
    readDisplayPreferences(pool, userId), readMethods(pool, userId),
    readSessions(pool, secret, userId, sessionId, { limit: exportCaps.devices }),
    readConnectedApps(pool, secret, userId, { limit: exportCaps.apps }),
    pool.query<{ id: string; action: string; detail: Record<string, unknown>; occurredAt: Date }>(`SELECT id, action, detail,
      occurred_at AS "occurredAt" FROM rezics_account_security_event WHERE user_id = $1
      ORDER BY occurred_at DESC, id DESC LIMIT $2`, [userId, exportCaps.events + 1]),
  ]);
  return { format: 'rezics-account-export/1' as const, exportedAt: new Date().toISOString(),
    account: { ...account, createdAt: account.createdAt.toISOString(), updatedAt: account.updatedAt.toISOString() },
    displayPreferences: { displayMode: preferences.displayMode, showZoneThemes: preferences.showZoneThemes },
    signInMethods: methods,
    devices: { items: devices.items.map(({ groupKey: _key, ...item }) => item), truncated: !!devices.nextCursor },
    connectedApps: { items: apps.items, truncated: !!apps.nextCursor },
    securityActivity: { items: events.rows.slice(0, exportCaps.events).map(row => ({ ...row,
      occurredAt: row.occurredAt.toISOString() })), truncated: events.rows.length > exportCaps.events } };
}

export function dataExportApi(auth: AccountAuth, pool: Pool) {
  const secret = String(auth.options.secret);
  return new Elysia()
    // POST, not a link: the download needs a recent sign-in, like any other
    // change that exposes the account, and must never be cached or prefetched.
    .post('/api/account/data-export', { response: accountResponses(accountExportView) }, async ({ request }) => {
      try {
        const session = await accountSession(auth, request);
        await requireStepUp(pool, session);
        if (!await consumeAccountLimit(pool, secret, `data-export:${session.user.id}`, 10, 3600)) {
          throw new AccountProblem('rate_limited', 429);
        }
        const archive = await exportAccountData(pool, secret, session.user.id, session.session.id);
        // The person sees the download in their activity, with "Wasn't you?".
        await securityEvent(pool, session.user.id, 'data_exported', {
          device: deviceLabel(request.headers.get('user-agent')),
          network: coarseNetwork(request.headers.get('x-rezics-client-ip')) });
        return new Response(JSON.stringify(archive, null, 2), { headers: {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="rezics-account-${archive.exportedAt.slice(0, 10)}.json"` } });
      } catch (error) { return accountFailure(error); }
    });
}
