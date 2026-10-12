import type { Pool } from 'pg';
import { lockPreservationTarget } from '../public-report/preservation.ts';

/** Release a real owner-created fixture hold under its preservation target lock. */
export async function releaseFixturePreservationHold(access: Pool, resource: string, caseId: string): Promise<void> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await lockPreservationTarget(client, resource);
    await client.query(`UPDATE access.governance_preservation_hold SET released_at = clock_timestamp()
      WHERE target_resource = $1 AND case_id = $2 AND released_at IS NULL`, [resource, caseId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
