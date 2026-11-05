import { expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import {
  nextIdentityScopeRepairHomes,
  nextIdentityScopeRepairTarget,
} from '../../src/semantic/identity-scoped-observations.ts';

test('fair repair rotates bounded scheduling cursors without an eventless domain command', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  try {
    const before = (await pool.query('SELECT position FROM core.partition WHERE partition_no=0')).rows;
    const first = await nextIdentityScopeRepairHomes(pool);
    const second = await nextIdentityScopeRepairHomes(pool);
    expect(first).toHaveLength(16);
    expect(second).toEqual(first.map((home) => (home + 16) % 4096));
    expect(await nextIdentityScopeRepairTarget(pool, 4095)).toBeNull();
    expect((await pool.query('SELECT position FROM core.partition WHERE partition_no=0')).rows).toEqual(before);
  } finally {
    await pool.end();
  }
});
