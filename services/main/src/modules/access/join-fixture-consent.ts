import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** Local web-auth fixtures predate person provisioning's consent grant. Match
 * that provisioning once, using its original live controller; any prior grant,
 * including an inactive one, means this repair must preserve the owner's choice.
 * Cost: at most nine indexed SQL statements, no graph reads. */
export async function repairJoiningFixtureConsent(
  pool: Pool,
  principalId: string,
  agent: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    if (
      !(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE'))
        .rowCount ||
      !(
        await client.query(`SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root'
        AND open AND dispatch_open FOR UPDATE`)
      ).rowCount
    )
      throw new Error('Local membership authority is unavailable');
    const controller = (
      await client.query<{ valid_until: string }>(
        `SELECT r.valid_until::text
      FROM access.agent_provision a
      JOIN access.principal p ON p.id = a.principal_id AND p.active
      JOIN access.authority_subject s ON s.id = a.agent_id AND s.kind = 'agent' AND s.active
      JOIN access.representation r ON r.id = a.representation_id AND r.principal_id = p.id
        AND r.subject_id = s.id AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
      WHERE a.principal_id = $1 AND a.agent_id = $2 AND a.agent_kind = 'person' AND a.state = 'active'
      LIMIT 1 FOR SHARE OF a,p,s,r`,
        [principalId, agent],
      )
    ).rows[0];
    const existing = (
      await client.query(
        `SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = 'work:create:root' AND action = 'access.membership.consent'
      LIMIT 1 FOR SHARE`,
        [agent],
      )
    ).rowCount;
    if (controller && !existing)
      await client.query(
        `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
      VALUES ($1,$2,$2,'work:create:root','access.membership.consent',$3,$4)`,
        [randomUUID(), agent, controller.valid_until, principalId],
      );
    await client.query('COMMIT');
    return !!controller && !existing;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
