import type { Pool, PoolClient } from 'pg';

const BATCH_ROWS = 5_000;

/** Set-based batches: one statement binds each column as one array parameter. */
export async function insertColumns(client: PoolClient, statement: string,
  rows: Iterable<unknown[]>, columns: number): Promise<number> {
  let batch: unknown[][] = Array.from({ length: columns }, () => []);
  let pending = 0;
  let inserted = 0;
  const flush = async () => {
    if (!pending) return;
    const result = await client.query(statement, batch);
    inserted += result.rowCount ?? 0;
    batch = Array.from({ length: columns }, () => []);
    pending = 0;
  };
  for (const row of rows) {
    if (row.length !== columns) throw new Error('fixture row width differs from its statement');
    row.forEach((value, index) => batch[index]!.push(value));
    if (++pending === BATCH_ROWS) await flush();
  }
  await flush();
  return inserted;
}

export async function ownerTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function countRows(pool: Pool, table: string): Promise<number> {
  if (!/^[a-z_]+\.[a-z_]+$/.test(table)) throw new Error('invalid fixture table');
  const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(result.rows[0]?.n);
}
