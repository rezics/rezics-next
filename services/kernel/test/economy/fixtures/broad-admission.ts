import type { Pool } from 'pg';
import { GLOBAL_CONTEXT } from '../../../src/access/gates/catalogue.ts';

export async function openBroadEconomyAdmission(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  const fixtureId = Bun.randomUUIDv7();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('test:economy:broad-admission', 0))");
    await client.query(
      `WITH grant_fixture AS (
        INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
        VALUES (0, $1, '00000000-0000-0000-0000-000000000000', 'active_accounts', 'gate:economy', '(,)', $2)
      )
      INSERT INTO access.exposure_opening ("group", valid, transaction_id)
      VALUES ('economy', tstzrange(statement_timestamp() - interval '1 second', NULL, '[)'), $2)`,
      [GLOBAL_CONTEXT.id, fixtureId],
    );
  } catch (error) {
    client.release(true);
    throw error;
  }

  return async () => {
    try {
      await client.query(
        `WITH removed_grant AS (
          DELETE FROM access.resource_grant
          WHERE route = 0 AND resource_id = $1 AND subject_kind = 'active_accounts'
            AND action = 'gate:economy' AND transaction_id = $2
        )
        DELETE FROM access.exposure_opening WHERE "group" = 'economy' AND transaction_id = $2`,
        [GLOBAL_CONTEXT.id, fixtureId],
      );
    } finally {
      client.release(true);
    }
  };
}
