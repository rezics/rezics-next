import type { Pool, PoolClient } from 'pg';

/** Access prepares its fixture scope and transaction; the test composes the
 * Governance writer without importing that owner's private files here. */
export async function withFixtureDisclosure(access: Pool,
  write: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO access.scope_gate (id) VALUES ('governance:platform') ON CONFLICT DO NOTHING`);
    await write(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
