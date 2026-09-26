import type { PoolClient } from 'pg';
import { privateGroupWorkProof, privateRoleWorkProof,
  selectedPrivateGroupWorkProof, selectedPrivateRoleWorkProof,
  type PrivateGroupProof, type PrivateRoleProof } from './private-recipient-proof.ts';

/** One complete direct Work creation proof. The attribution row authorizes the
 * named public Agent; it never supplies the principal's missing domain grant. */
export async function directWorkCreateProof(client: PoolClient, principalId: string,
  actingSubject: string): Promise<{
    grantId: string | null; grantGeneration: string | null;
    group: PrivateGroupProof | null; role: PrivateRoleProof | null;
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
  if (!attributed.rows[0]) return null;
  const group = granted.rows[0] ? null : await privateGroupWorkProof(client, principalId);
  const role = granted.rows[0] || group ? null : await privateRoleWorkProof(client, principalId);
  if (!granted.rows[0] && !group && !role) return null;
  return { grantId: granted.rows[0]?.id ?? null,
    grantGeneration: granted.rows[0]?.generation ?? null, group, role,
    attributionId: attributed.rows[0].id,
    attributionGeneration: attributed.rows[0].generation,
    subjectGeneration: attributed.rows[0].subject_generation };
}

/** Check the saved branch only. A newly acquired independent path cannot
 * reactivate an old admission after its original episode has ended. */
export async function selectedDirectWorkProof(client: PoolClient, row: {
  principal_id: string; acting_subject: string; scope_id: string;
  direct_grant_id: string | null; direct_grant_generation: string | null;
  attribution_id: string | null; attribution_generation: string | null;
  direct_subject_generation: string | null; direct_principal_epoch: string | null;
  private_group_member_id: string | null; private_group_member_generation: string | null;
  private_group_grant_id: string | null; private_group_grant_generation: string | null;
  private_group_generation: string | null;
  private_role_binding_id: string | null; private_role_binding_generation: string | null;
  private_role_family_id: string | null; private_role_revision: string | null;
}, currentPrincipalEpoch: string): Promise<boolean> {
  if (row.direct_principal_epoch !== currentPrincipalEpoch) return false;
  const attribution = await client.query(`SELECT a.id FROM access.principal_agent_attribution a
    JOIN access.authority_subject s ON s.id = a.agent_subject
    WHERE a.id = $1 AND a.principal_id = $2 AND a.agent_subject = $3
      AND a.action = 'work.create' AND a.active AND a.valid_until > clock_timestamp()
      AND a.generation = $4 AND s.kind = 'agent' AND s.active
      AND s.generation = $5 FOR SHARE OF a, s`,
  [row.attribution_id, row.principal_id, row.acting_subject,
    row.attribution_generation, row.direct_subject_generation]);
  if (attribution.rowCount !== 1) return false;
  if (row.direct_grant_id) {
    const grant = await client.query(`SELECT g.id FROM access.principal_permission_grant g
      WHERE g.id = $1 AND g.principal_id = $2 AND g.scope_id = $3
        AND g.action = 'work.create' AND g.active AND g.valid_until > clock_timestamp()
        AND g.generation = $4
        AND (g.private_membership_id IS NULL OR EXISTS (
          SELECT 1 FROM access.private_membership m
          WHERE m.id = g.private_membership_id AND m.principal_id = $2
            AND m.state = 'joined' AND m.generation = g.private_membership_generation))
      FOR SHARE OF g`, [row.direct_grant_id, row.principal_id,
    row.scope_id, row.direct_grant_generation]);
    return grant.rowCount === 1;
  }
  if (row.private_group_member_id && row.private_group_grant_id
    && row.private_group_member_generation && row.private_group_grant_generation
    && row.private_group_generation) {
    return selectedPrivateGroupWorkProof(client, row.principal_id, {
      memberId: row.private_group_member_id,
      memberGeneration: row.private_group_member_generation,
      grantId: row.private_group_grant_id,
      grantGeneration: row.private_group_grant_generation,
      groupGeneration: row.private_group_generation,
    });
  }
  if (row.private_role_binding_id && row.private_role_binding_generation
    && row.private_role_family_id && row.private_role_revision) {
    return selectedPrivateRoleWorkProof(client, row.principal_id, {
      bindingId: row.private_role_binding_id,
      bindingGeneration: row.private_role_binding_generation,
      familyId: row.private_role_family_id,
      roleRevision: row.private_role_revision,
    });
  }
  return false;
}
