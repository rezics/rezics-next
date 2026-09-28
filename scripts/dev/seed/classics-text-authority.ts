import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
    await client.query("INSERT INTO access.scope_gate (id) VALUES ('rights:assess') ON CONFLICT DO NOTHING");
    const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
      "SELECT open, dispatch_open FROM access.scope_gate WHERE id = 'rights:assess' FOR SHARE");
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) throw new Error('Rights assessment gate is closed');
    await client.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      SELECT $1,$2,$3,'rights.assess',now() + interval '8 hours'
      WHERE NOT EXISTS (SELECT 1 FROM access.representation WHERE principal_id = $2
        AND subject_id = $3 AND action = 'rights.assess' AND active AND valid_until > now())`,
    [randomUUID(), principal.rows[0].id, input.actingSubject]);
    await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      SELECT $1,$2,$2,'rights:assess','rights.assess',now() + interval '8 hours'
      WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant WHERE recipient_subject = $2
        AND scope_id = 'rights:assess' AND action = 'rights.assess' AND active AND valid_until > now())`,
    [randomUUID(), input.actingSubject]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}
