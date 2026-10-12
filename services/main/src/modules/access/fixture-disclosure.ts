import type { Pool } from 'pg';
import { recordFixtureDisclosure } from '../governance/fixture-disclosure.ts';

/** Commit an attributable exact Content fence for delivery-race fixtures.
 * Case/decision admission has its own suites; this helper preserves their
 * owner references without exposing fixture writes to delivery tests. */
export async function restrictFixtureDisclosure(access: Pool, input: {
  resourceId: string; revisionId: string; effect: 'disclosure' | 'search';
  principalId: string; actingSubject: string;
}): Promise<void> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO access.scope_gate (id) VALUES ('governance:platform') ON CONFLICT DO NOTHING`);
    await recordFixtureDisclosure(client, input);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
