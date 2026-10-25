import { expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) : '';

if (!database.startsWith('kernel_test_')) {
  test.skip('check resources require a kernel_test_* DATABASE_URL from bun run check', () => {});
} else {
  test('a test file under the check sees only its own database copy and a bounded template', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const copies = await pool.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname, 'kernel_test_') ORDER BY datname",
      );
      expect(copies.rows).toEqual([{ datname: database }]);

      const template = await pool.query<{ bytes: string }>("SELECT pg_database_size('rezics') AS bytes");
      expect(Number(template.rows[0]!.bytes)).toBeLessThanOrEqual(256 * 1024 * 1024);
    } finally {
      await pool.end();
    }
  });
}
