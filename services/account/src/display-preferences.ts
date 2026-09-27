import { Elysia, t } from 'elysia';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { currentIntrospection } from './introspection.ts';
import { accountResponses } from './views.ts';

export const displayModes = ['system', 'light', 'dark'] as const;
export type DisplayMode = typeof displayModes[number];
export interface DisplayPreferences { revision: number; displayMode: DisplayMode; showZoneThemes: boolean }

const view = t.Object({ revision: t.Number(), displayMode: t.Union([
  t.Literal('system'), t.Literal('light'), t.Literal('dark')]), showZoneThemes: t.Boolean() });

/** One primary-key read. An absent row has the same defaults as a signed-out browser. */
export async function readDisplayPreferences(pool: Pool, userId: string): Promise<DisplayPreferences> {
  const result = await pool.query<{ revision: string; display_mode: DisplayMode; show_zone_themes: boolean }>(
    'SELECT revision, display_mode, show_zone_themes FROM rezics_display_preferences WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  return row ? { revision: Number(row.revision), displayMode: row.display_mode, showZoneThemes: row.show_zone_themes }
    : { revision: 0, displayMode: 'system', showZoneThemes: true };
}

/** One bounded primary-key upsert. The revision makes concurrent whole-value writes explicit. */
export async function writeDisplayPreferences(pool: Pool, userId: string, expectedRevision: number,
  displayMode: DisplayMode, showZoneThemes: boolean): Promise<DisplayPreferences | null> {
  const result = await pool.query<{ revision: string; display_mode: DisplayMode; show_zone_themes: boolean }>(`
    INSERT INTO rezics_display_preferences (user_id, revision, display_mode, show_zone_themes)
    SELECT $1, 1, $3, $4 WHERE $2::bigint = 0
      OR EXISTS (SELECT 1 FROM rezics_display_preferences WHERE user_id = $1)
    ON CONFLICT (user_id) DO UPDATE SET revision = rezics_display_preferences.revision + 1,
      display_mode = EXCLUDED.display_mode, show_zone_themes = EXCLUDED.show_zone_themes
      WHERE rezics_display_preferences.revision = $2
    RETURNING revision, display_mode, show_zone_themes`, [userId, expectedRevision, displayMode, showZoneThemes]);
  const row = result.rows[0];
  return row ? { revision: Number(row.revision), displayMode: row.display_mode, showZoneThemes: row.show_zone_themes } : null;
}

async function preferenceUser(auth: AccountAuth, pool: Pool, request: Request,
  allowedClientIds: ReadonlySet<string>): Promise<string> {
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(String(auth.options.baseURL)).origin) {
    throw new AccountProblem('invalid_origin', 403);
  }
  if (!request.headers.has('authorization')) return (await accountSession(auth, request)).user.id;
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  let claims: ReturnType<typeof decodeJwt> | undefined;
  try { if (token) claims = decodeJwt(token); } catch { /* invalid bearer */ }
  const clientId = claims?.client_id;
  if (typeof clientId !== 'string') throw new AccountProblem('unauthenticated', 401);
  if (!allowedClientIds.has(clientId)) throw new AccountProblem('forbidden', 403);
  const profile = await auth.api.oauth2UserInfo({ headers: request.headers }).catch(() => null);
  if (!profile || typeof profile.sub !== 'string' || !profile.sub) throw new AccountProblem('unauthenticated', 401);
  // UserInfo verifies the bearer signature; Account's current introspection
  // also checks revocation, suspension and the grant's present generation.
  const current = await currentIntrospection(pool, token!, Response.json({ ...claims, active: true }));
  if (!current.ok) throw new AccountProblem('temporarily_unavailable', 503);
  if ((await current.json() as { active?: boolean }).active !== true || claims?.sub !== profile.sub) {
    throw new AccountProblem('unauthenticated', 401);
  }
  return profile.sub;
}

export function displayPreferencesApi(auth: AccountAuth, pool: Pool, allowedClientIds: ReadonlySet<string>) {
  return new Elysia()
    .get('/api/account/display-preferences', { response: accountResponses(view) }, async ({ request }) => {
      try { return accountJson(await readDisplayPreferences(pool, await preferenceUser(auth, pool, request, allowedClientIds))); }
      catch (error) { return accountFailure(error); }
    })
    .put('/api/account/display-preferences', { body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }),
      displayMode: view.properties.displayMode, showZoneThemes: t.Boolean() }, { additionalProperties: false }),
    response: accountResponses(view) }, async ({ request, body }) => {
      try {
        const userId = await preferenceUser(auth, pool, request, allowedClientIds);
        const saved = await writeDisplayPreferences(pool, userId, body.expectedRevision,
          body.displayMode, body.showZoneThemes);
        if (!saved) throw new AccountProblem('conflict', 409);
        return accountJson(saved);
      } catch (error) { return accountFailure(error); }
    });
}
