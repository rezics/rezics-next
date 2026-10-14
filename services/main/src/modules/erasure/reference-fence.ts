import { contentSessionClient } from '../../../../content/src/connection.ts';
import type { Pool, PoolClient } from 'pg';

/** All references to existing bytes and their deletion use the Content database.
 * A borrowed client keeps the fence until its owner's transaction commits. */
export async function withReferenceFence<T>(database: Pool | PoolClient, digest: string,
  write: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('invalid reference fence digest');
  // PoolClient also exposes Client.connect; release identifies a checked-out
  // client whose existing transaction must retain the lock through commit.
  const borrowed = 'release' in database;
  const session = borrowed ? undefined : contentSessionClient(database as Pool);
  const client = borrowed ? database as PoolClient : session ?? await (database as Pool).connect();
  try {
    if (!borrowed) await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-payload-reference:' || $1, 0))", [digest]);
    const result = await write(client);
    if (!borrowed) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!borrowed) await client.query('ROLLBACK');
    throw error;
  } finally { if (!borrowed && !session) client.release(); }
}
