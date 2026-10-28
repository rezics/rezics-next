import { expect, test } from 'bun:test';
import { createPool } from '../src/database/pool.ts';

test('pool decodes PostgreSQL name arrays with escaped identifiers, nulls and empty arrays', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const names = ['partition_no', 'a,b', 'a"b', 'a\\b', 'NULL', '', null];
  try {
    const { rows } = await pool.query(
      'SELECT $1::name[] AS names, ARRAY[]::name[] AS empty, $1::text[] AS texts, 9223372036854775807::bigint AS position',
      [names],
    );
    expect(rows[0]).toEqual({ names, empty: [], texts: names, position: '9223372036854775807' });
  } finally {
    await pool.end();
  }
});
