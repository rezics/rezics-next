import { afterAll, expect, spyOn, test } from 'bun:test';
import { deadlineClient } from '../../src/access/authenticate.ts';
import { readPublicIdentityObservations } from '../../src/access/account-data.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

test('the caller deadline fails closed without retrying or opening another connection', async () => {
  const client = await pool.connect();
  const query = spyOn(client, 'query');
  const connect = spyOn(pool, 'connect');
  try {
    await expect(
      readPublicIdentityObservations(deadlineClient(client, Date.now() - 10_000), [newId(0x4567)]),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    connect.mockRestore();
    client.release();
  }
});
