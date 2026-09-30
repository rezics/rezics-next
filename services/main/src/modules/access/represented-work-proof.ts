import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { selectedGroupWorkProof } from './groups.ts';
import { publicCatalogueWork, selectedRoleWorkProof } from './role-proof.ts';

export interface RepresentedWorkProof {
  representationId: string;
  representationGeneration: string;
  subjectGeneration: string;
  grantId: string | null;
  grantGeneration: string | null;
}

export interface SavedRepresentedWorkProof {
  principal_id: string;
  acting_subject: string;
  scope_id: string;
  action: string;
  represented_representation_id: string | null;
  represented_representation_generation: string | null;
  represented_grant_id: string | null;
  represented_grant_generation: string | null;
  represented_subject_generation: string | null;
  represented_principal_epoch: string | null;
  group_member_id: string | null;
  group_grant_id: string | null;
  group_generation: string | null;
  role_binding_id: string | null;
  role_binding_generation: string | null;
  role_family_id: string | null;
  role_revision: string | null;
}

/** Select one indexed mandate and one direct grant. A provisioned Person's
 * original live controller is sufficient representation, but grants no Work
 * permission: a separate grant, group or role is still required. Reusing that
 * mandate keeps revocation pinned without issuing a duplicate representation. */
export async function representedWorkProof(client: PoolClient, principalId: string,
  actingSubject: string, action: 'work.create' | 'work.edit' = 'work.create',
  scope = 'work:create:root'): Promise<RepresentedWorkProof | null> {
  const representation = await client.query<{
    id: string; generation: string; subject_generation: string;
  }>(`SELECT r.id, r.generation, s.generation AS subject_generation
    FROM access.representation r
    JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.principal_id = $1 AND r.subject_id = $2
      AND (r.action = $3 OR r.action = 'agent.control' AND EXISTS (
        SELECT 1 FROM access.agent_provision a WHERE a.principal_id = r.principal_id
          AND a.agent_id = r.subject_id AND a.representation_id = r.id
          AND a.agent_kind = 'person' AND a.state = 'active'))
      AND r.active AND r.valid_until > clock_timestamp()
      AND s.kind = 'agent' AND s.active
    ORDER BY r.id LIMIT 1 FOR SHARE OF r, s`, [principalId, actingSubject, action]);
  const selected = representation.rows[0];
  if (!selected) return null;
  const grant = await client.query<{ id: string; generation: string }>(`
    SELECT id, generation FROM access.permission_grant
    WHERE recipient_subject = $1 AND scope_id = $2
      AND action = $3 AND active AND valid_until > clock_timestamp()
    ORDER BY id LIMIT 1 FOR SHARE`, [actingSubject, scope, action]);
  return { representationId: selected.id,
    representationGeneration: selected.generation,
    subjectGeneration: selected.subject_generation,
    grantId: grant.rows[0]?.id ?? null,
    grantGeneration: grant.rows[0]?.generation ?? null };
}

/** This checks only the saved path. Another valid mandate or grant may support
 * a new registration, but cannot revive this admission. */
export async function selectedRepresentedWorkProof(client: PoolClient,
  saved: SavedRepresentedWorkProof, principalEpoch: string,
  groupGeneration: string, graph?: Pick<FusekiClient, 'query'>): Promise<boolean> {
  const edit = saved.action === 'work.edit' && saved.scope_id.startsWith('work:edit:');
  if (!(saved.action === 'work.create' && saved.scope_id === 'work:create:root' || edit)
    || !saved.represented_representation_id
    || saved.represented_representation_generation === null
    || saved.represented_subject_generation === null
    || saved.represented_principal_epoch !== principalEpoch) return false;
  const mandate = await client.query(`SELECT r.id FROM access.representation r
    JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.id = $1 AND r.principal_id = $2 AND r.subject_id = $3
      AND (r.action = $6 OR r.action = 'agent.control' AND EXISTS (
        SELECT 1 FROM access.agent_provision a WHERE a.principal_id = r.principal_id
          AND a.agent_id = r.subject_id AND a.representation_id = r.id
          AND a.agent_kind = 'person' AND a.state = 'active')) AND r.active
      AND r.valid_until > clock_timestamp() AND r.generation = $4
      AND s.kind = 'agent' AND s.active AND s.generation = $5
    FOR SHARE OF r, s`, [saved.represented_representation_id,
    saved.principal_id, saved.acting_subject,
    saved.represented_representation_generation,
    saved.represented_subject_generation, saved.action]);
  if (mandate.rowCount !== 1) return false;
  if (saved.represented_grant_id) {
    if (saved.group_grant_id || saved.role_binding_id
      || saved.represented_grant_generation === null) return false;
    const grant = await client.query(`SELECT id FROM access.permission_grant
      WHERE id = $1 AND recipient_subject = $2 AND scope_id = $3
        AND action = $5 AND active AND valid_until > clock_timestamp()
        AND generation = $4 FOR SHARE`, [saved.represented_grant_id,
      saved.acting_subject, saved.scope_id, saved.represented_grant_generation, saved.action]);
    return grant.rowCount === 1;
  }
  if (saved.role_binding_id) {
    if (saved.group_grant_id || saved.represented_grant_generation !== null
      || saved.role_binding_generation === null
      || saved.role_family_id === null || saved.role_revision === null) return false;
    if (edit && !await publicCatalogueWork(graph, saved.scope_id.slice('work:edit:'.length))) return false;
    return selectedRoleWorkProof(client, saved.acting_subject, {
      bindingId: saved.role_binding_id,
      bindingGeneration: saved.role_binding_generation,
      familyId: saved.role_family_id, roleRevision: saved.role_revision,
    }, edit ? 'work.edit' : 'work.create');
  }
  return !edit && saved.represented_grant_generation === null
    && saved.group_grant_id !== null && saved.group_member_id !== null
    && saved.group_generation === groupGeneration
    && await selectedGroupWorkProof(client, saved.acting_subject,
      saved.group_member_id, saved.group_grant_id);
}
