import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { nextOwnerIndexAccount } from '../../src/library/owner-index.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

test('owner index discovery resumes at a sparse partition, at a sibling on the same route, and at exhaustion', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const accounts = [newId(0x0100), newId(0xfff0), newId(0xfff0)];
    for (const account of accounts) {
      await client.query('INSERT INTO library.fact_source_head(route,account_id,generation) VALUES($1,$2,1)', [
        routeOf(account),
        account,
      ]);
    }
    // Other native fixtures can also have owners in the same database.
    const { rows } = await client.query<{ route: number; account: string }>(
      'SELECT route,account_id AS account FROM library.fact_source_head WHERE route>=32768 ORDER BY route,account_id',
    );
    expect(rows.map((row) => row.account)).toEqual(expect.arrayContaining(accounts.slice(1)));
    expect(await nextOwnerIndexAccount(client, { partition: 2048, route: null, account: null })).toEqual(rows[0]);
    for (const [index, row] of rows.entries()) {
      expect(await nextOwnerIndexAccount(client, { partition: partitionOf(row.route), ...row })).toEqual(
        rows[index + 1],
      );
    }
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  }
});
