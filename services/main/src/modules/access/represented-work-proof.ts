import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { selectedGroupWorkProof } from './groups.ts';
import { publicCatalogueWork, selectedRoleWorkProof } from './role-proof.ts';
import { randomUUID } from 'node:crypto';
import { ControlUnavailable } from './topology-control.ts';
import { MAX_TOPOLOGY_WALK } from './topology-schema.ts';

export interface RepresentedWorkProof {
  representationId: string;
  representationGeneration: string;
  subjectGeneration: string;
  grantId: string | null;
  grantGeneration: string | null;
  path?: { origin: string; edgeId: string; edgeGeneration: string; topologyEpoch: string;
    validUntil: Date };
}

export interface SavedRepresentedWorkProof {
  id: string;
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

/** Select one indexed mandate and one direct grant. A live controller is
 * sufficient representation of its Agent, but grants no Work
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
      AND r.action IN ($3,'agent.control')
      AND r.active AND r.valid_until > clock_timestamp()
      AND s.kind = 'agent' AND s.active
    ORDER BY r.id LIMIT 1 FOR SHARE OF r, s`, [principalId, actingSubject, action]);
  const selected = representation.rows[0];
  if (!selected) return action === 'work.create' && scope === 'work:create:root'
    ? invitedWorkProof(client, principalId, actingSubject) : null;
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

/** An accepted publishing edge composes the recipient's current Person
 * controller with exactly one edge and the represented Agent's own ceiling.
 * Cost: one represented-Agent edge index probe (degree <=16), indexed joins,
 * and one topology fence. No recursive discovery or alternative path pooling. */
async function invitedWorkProof(client: PoolClient, principalId: string,
  actingSubject: string): Promise<RepresentedWorkProof | null> {
  const topology = (await client.query<{ authority_epoch: string }>(`SELECT authority_epoch
    FROM access.scope_gate WHERE id = 'access:representation-topology' FOR SHARE`)).rows[0];
  if (!topology) return null;
  const row = (await invitedWorkRows(client, principalId, actingSubject, 1))[0];
  return row ? { representationId: row.id, representationGeneration: row.generation,
    subjectGeneration: row.subject_generation, grantId: row.grant_id,
    grantGeneration: row.grant_generation, path: { origin: row.origin, edgeId: row.edge_id,
      edgeGeneration: row.edge_generation, topologyEpoch: topology.authority_epoch,
      validUntil: row.valid_until } } : null;
}

/** Identity discovery and Work eligibility share the accepted one-hop predicate.
 * One indexed recipient/controller join, capped by the topology walk bound;
 * neither the Work gate nor the recipient's own Work grants determine identity. */
export async function invitedWorkAgents(client: PoolClient, principalId: string): Promise<string[]> {
  const rows = await invitedWorkRows(client, principalId, null, MAX_TOPOLOGY_WALK + 1);
  if (rows.length > MAX_TOPOLOGY_WALK) {
    throw new ControlUnavailable('identity invitation walk exceeds supported limit');
  }
  return [...new Set(rows.map(row => row.acting_subject))].sort();
}

async function invitedWorkRows(client: PoolClient, principalId: string,
  actingSubject: string | null, limit: number) {
  return (await client.query<{ id: string; generation: string; subject_generation: string;
    acting_subject: string; origin: string; edge_id: string; edge_generation: string; grant_id: string;
    grant_generation: string; valid_until: Date }>(`SELECT r.id,r.generation,
      target.id AS acting_subject,target.generation AS subject_generation,r.subject_id AS origin,e.id AS edge_id,
      e.generation AS edge_generation,g.id AS grant_id,g.generation AS grant_generation,
      least(r.valid_until,e.valid_until,g.valid_until) AS valid_until
    FROM access.representation_edge e
    JOIN access.agent_invitation i ON i.id = e.invitation_id AND i.offer = 'represent'
    JOIN access.agent_invitation_acceptance accepted ON accepted.invitation_id = i.id AND accepted.edge_id = e.id
    JOIN access.representation r ON r.subject_id = e.representative_subject
      AND r.principal_id = $1 AND r.action = 'agent.control' AND r.active
      AND r.valid_until > clock_timestamp()
    JOIN access.agent_provision person ON person.agent_id = r.subject_id
      AND person.agent_kind = 'person' AND person.state = 'active'
    JOIN access.authority_subject origin ON origin.id = r.subject_id AND origin.active
    JOIN access.authority_subject target ON target.id = e.represented_subject AND target.active
    JOIN access.permission_grant g ON g.id = e.ceiling_grant_id AND g.recipient_subject = target.id
      AND g.scope_id = 'work:create:root' AND g.action = 'work.create' AND g.active
      AND g.generation = e.ceiling_grant_generation AND g.valid_until > clock_timestamp()
    LEFT JOIN access.grant_lineage lineage ON lineage.grant_id = g.id
    WHERE ($2::text IS NULL OR e.represented_subject = $2) AND e.action = 'work.create' AND e.active
      AND e.valid_until > clock_timestamp() AND e.resource_subject IS NULL AND e.max_path_edges = 1
      AND lineage.representative_policy_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM access.agent_invitation_revocation revoked
        WHERE revoked.invitation_id = i.id)
    ORDER BY e.id,r.id LIMIT $3 FOR SHARE OF r,e,g,origin,target`,
  [principalId, actingSubject, limit])).rows;
}

/** Persist the selected edge in the existing path/obligation objects so strong
 * revocation sees both registered and running Work commands. */
export async function saveInvitedWorkProof(client: PoolClient, admissionId: string,
  principalId: string, principalEpoch: string, actingSubject: string,
  proof: RepresentedWorkProof): Promise<void> {
  if (!proof.path) return;
  const pathId = randomUUID();
  await client.query(`INSERT INTO access.representation_path_proof (id,principal_id,
    principal_epoch,representation_id,representation_generation,mandate_action,origin_subject,
    acting_subject,action,edge_count,topology_epoch,valid_until)
    VALUES ($1,$2,$3,$4,$5,'agent.control',$6,$7,'work.create',1,$8,$9)`,
  [pathId,principalId,principalEpoch,proof.representationId,proof.representationGeneration,
    proof.path.origin,actingSubject,proof.path.topologyEpoch,proof.path.validUntil]);
  await client.query(`INSERT INTO access.representation_path_step (path_id,position,edge_id,
    edge_generation,representative_subject,represented_subject,action)
    VALUES ($1,1,$2,$3,$4,$5,'work.create')`,
  [pathId,proof.path.edgeId,proof.path.edgeGeneration,proof.path.origin,actingSubject]);
  await client.query(`INSERT INTO access.admission_obligation (admission_id,obligation,
    principal_id,acting_subject,scope_id,path_id,source_kind,grant_id,grant_generation)
    VALUES ($1,'work.create',$2,$3,'work:create:root',$4,'grant',$5,$6)`,
  [admissionId,principalId,actingSubject,pathId,proof.grantId,proof.grantGeneration]);
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
  const path = (await client.query<{ origin_subject: string; edge_id: string; edge_generation: string;
    representation_generation: string; valid_until: Date }>(`SELECT p.origin_subject,
      p.representation_generation,p.valid_until,s.edge_id,s.edge_generation
    FROM access.admission_obligation o JOIN access.representation_path_proof p ON p.id = o.path_id
    JOIN access.representation_path_step s ON s.path_id = p.id AND s.position = 1
    WHERE o.admission_id = $1 AND o.obligation = $2 AND o.principal_id = $3
      AND o.acting_subject = $4 AND o.grant_id = $5 AND o.grant_generation = $6
      AND p.representation_id = $7 AND p.principal_epoch = $8
      AND p.mandate_action = 'agent.control' AND p.edge_count = 1`,
  [saved.id,saved.action,saved.principal_id,saved.acting_subject,saved.represented_grant_id,
    saved.represented_grant_generation,saved.represented_representation_id,principalEpoch])).rows[0];
  if (path) {
    if (edit || path.representation_generation !== saved.represented_representation_generation
      || path.valid_until.getTime() <= Date.now()) return false;
    // Recheck the saved edge, never select another valid invitation on retry.
    const live = await client.query(`SELECT 1 FROM access.representation r
      JOIN access.authority_subject origin ON origin.id = r.subject_id AND origin.active
      JOIN access.authority_subject target ON target.id = $3 AND target.active AND target.generation = $5
      JOIN access.representation_edge e ON e.id = $6 AND e.representative_subject = r.subject_id
        AND e.represented_subject = target.id AND e.action = 'work.create' AND e.active
        AND e.generation = $7 AND e.valid_until > clock_timestamp()
      JOIN access.agent_invitation i ON i.id = e.invitation_id AND i.offer = 'represent'
      JOIN access.agent_invitation_acceptance a ON a.invitation_id = i.id AND a.edge_id = e.id
      JOIN access.permission_grant g ON g.id = $8 AND g.id = e.ceiling_grant_id
        AND g.recipient_subject = target.id AND g.scope_id = 'work:create:root' AND g.action = 'work.create'
        AND g.active AND g.generation = $9 AND g.generation = e.ceiling_grant_generation
        AND g.valid_until > clock_timestamp()
      LEFT JOIN access.grant_lineage l ON l.grant_id = g.id
      WHERE r.id = $1 AND r.principal_id = $2 AND r.subject_id = $10
        AND r.action = 'agent.control' AND r.active AND r.generation = $4
        AND r.valid_until > clock_timestamp() AND l.representative_policy_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM access.agent_invitation_revocation v WHERE v.invitation_id = i.id)
      FOR SHARE OF r,e,g,origin,target`,
    [saved.represented_representation_id,saved.principal_id,saved.acting_subject,
      saved.represented_representation_generation,saved.represented_subject_generation,
      path.edge_id,path.edge_generation,saved.represented_grant_id,saved.represented_grant_generation,
      path.origin_subject]);
    return live.rowCount === 1;
  }
  const mandate = await client.query(`SELECT r.id FROM access.representation r
    JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.id = $1 AND r.principal_id = $2 AND r.subject_id = $3
      AND r.action IN ($6,'agent.control') AND r.active
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
