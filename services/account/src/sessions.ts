import type { Pool } from 'pg';
import type { AccountAuth } from './http.ts';

/** An admitted authorization names the client last used by this browser session.
 * The hint only labels the session list; it never grants access. */
export async function recordSessionClient(auth: AccountAuth, pool: Pool, request: Request,
  response: Response, clientId: string | null): Promise<void> {
  if (!clientId || response.status !== 302) return;
  const location = response.headers.get('location');
  if (!location) return;
  const redirect = new URL(location, request.url);
  if (redirect.searchParams.getAll('code').length !== 1 || !redirect.searchParams.get('code')
    || redirect.searchParams.has('error')) return;
  const current = await auth.api.getSession({ headers: request.headers });
  if (!current) return;
  await pool.query(`UPDATE "session" SET rezics_client_id = $1
    WHERE id = $2 AND "userId" = $3`, [clientId, current.session.id, current.user.id]);
}
