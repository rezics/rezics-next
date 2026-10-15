import type { Pool, PoolClient } from 'pg';

/** ORDER/LIMIT alone can still sort a whole inventory. Scope the indexed-read
 * plan to this batch, then restore the caller's planner settings. Each source
 * has an ordered index; bitmap scans would materialize its entire range.
 * A borrowed client normally belongs to a transaction. An idle session owner
 * passes transaction=true to open and close its own read transaction.
 * https://www.postgresql.org/docs/18/runtime-config-query.html
 * https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-SET
 */
export async function indexedRead<T>(
  pool: Pool | PoolClient,
  read: (client: Pick<PoolClient, 'query'>) => Promise<T>,
  transaction = !('release' in pool),
): Promise<T> {
  const scoped = async (client: Pick<PoolClient, 'query'>) => {
    const previous = (
      await client.query<{ sequential: string; bitmap: string }>(
        `SELECT current_setting('enable_seqscan') AS sequential,current_setting('enable_bitmapscan') AS bitmap`,
      )
    ).rows[0]!;
    await client.query(
      `SELECT set_config('enable_seqscan','off',true),set_config('enable_bitmapscan','off',true)`,
    );
    try {
      return await read(client);
    } finally {
      await client
        .query(
          `SELECT set_config('enable_seqscan',$1,true),set_config('enable_bitmapscan',$2,true)`,
          [previous.sequential, previous.bitmap],
        )
        .catch(() => {});
    }
  };
  if (!transaction && 'release' in pool) return scoped(pool);
  const client = 'release' in pool ? pool : await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await scoped(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (client !== pool) client.release();
  }
}

