import { Pool } from 'pg';
import { grantFixtureAuthority, rethrowFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import type { LocalOperatorInput } from './operator.ts';

/** The fixture editor can record the seven editions' assessments; text still passes through Main. */
export async function grantClassicAssessmentAuthority(input: LocalOperatorInput): Promise<void> {
  const url = new URL(input.accessDatabaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Classic seed authority requires a loopback database');
  }
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const principal = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [`${input.endpoints.account}/api/auth`, input.ownerAccountSubject]);
    if (!principal.rows[0]) throw new Error('Classic editor has no active principal');
    try {
      await grantFixtureAuthority(client, {
        scope: 'rights:assess', requireDispatch: true,
        representations: [{ principalId: principal.rows[0].id, actor: input.actingSubject,
          action: 'rights.assess', lifetime: '8 hours' }],
        grant: { actor: input.actingSubject, action: 'rights.assess', lifetime: '8 hours' },
      });
    } catch (error) {
      rethrowFixtureAuthority(error, { gate: 'Rights assessment gate is closed' });
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}
