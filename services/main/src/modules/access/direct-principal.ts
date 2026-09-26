import type { PoolClient } from 'pg';

/** One complete direct Work creation proof. The attribution row authorizes the
 * named public Agent; it never supplies the principal's missing domain grant. */
export async function directWorkCreateProof(client: PoolClient, principalId: string,
  actingSubject: string): Promise<{
    grantId: string; grantGeneration: string;
    attributionId: string; attributionGeneration: string;
    subjectGeneration: string;
  } | null> {
  const granted = await client.query<{ id: string; generation: string }>(`
    SELECT id, generation FROM access.principal_permission_grant
    WHERE principal_id = $1 AND scope_id = 'work:create:root'
      AND action = 'work.create' AND active AND valid_until > clock_timestamp()
      AND (private_membership_id IS NULL OR EXISTS (
        SELECT 1 FROM access.private_membership m
        WHERE m.id = private_membership_id AND m.principal_id = $1
          AND m.state = 'joined' AND m.generation = private_membership_generation))
    LIMIT 1 FOR SHARE`, [principalId]);
  const attributed = await client.query<{
    id: string; generation: string; subject_generation: string;
  }>(`
    SELECT a.id, a.generation, s.generation AS subject_generation
    FROM access.principal_agent_attribution a
    JOIN access.authority_subject s ON s.id = a.agent_subject
    WHERE a.principal_id = $1 AND a.agent_subject = $2
      AND a.action = 'work.create' AND a.active AND a.valid_until > clock_timestamp()
      AND s.kind = 'agent' AND s.active
    LIMIT 1 FOR SHARE OF a, s`, [principalId, actingSubject]);
  if (!granted.rows[0] || !attributed.rows[0]) return null;
  return { grantId: granted.rows[0].id, grantGeneration: granted.rows[0].generation,
    attributionId: attributed.rows[0].id,
    attributionGeneration: attributed.rows[0].generation,
    subjectGeneration: attributed.rows[0].subject_generation };
}
