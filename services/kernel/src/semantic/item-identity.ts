import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import readVersion from './read-item-identity-version.sql';

/**
 * Read validation metadata for an already-read item using the caller's transaction snapshot.
 * This does not establish read authority or follow a redirect.
 */
export async function readItemIdentityVersion(
  client: Pick<PoolClient, 'query'>,
  id: string,
): Promise<{ revision: number; transactionId: string; redirect: string | null } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const row = await readVersion.run(client as PoolClient, { route, subject_id: id });
  if (!row) return null;
  return {
    revision: Number(row.revision),
    transactionId: row.transactionId,
    redirect: row.redirect,
  };
}
