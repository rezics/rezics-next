import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { checkSqlFiles } from '../support/partition-binding.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
});

test('every progress and published log statement binds one route parameter', async () => {
  const client = await pool.connect();
  try {
    const results = (await checkSqlFiles(client, new URL('../../src/library/', import.meta.url).pathname)).filter(
      (result) => /^(progress-store|published-log)-/.test(result.file),
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((result) => 'bound' in result.binding && !result.binding.bound)).toEqual([]);
  } finally {
    client.release();
  }
});
