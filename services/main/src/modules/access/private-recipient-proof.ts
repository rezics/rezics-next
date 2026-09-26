import type { PoolClient } from 'pg';
import { GroupUnavailable } from './groups.ts';
import { RoleUnavailable } from './roles.ts';

const SCOPE = 'work:create:root';
const MAX_GROUPS_PER_PRINCIPAL = 16;
const MAX_DEPTH = 32;
const MAX_ROLES_PER_PRINCIPAL = 16;

export interface PrivateGroupProof {
  memberId: string;
  memberGeneration: string;
  grantId: string;
  grantGeneration: string;
  groupGeneration: string;
}
export interface PrivateRoleProof {
  bindingId: string;
  bindingGeneration: string;
  familyId: string;
  roleRevision: string;
}

/** Private membership rows select a path to a group grant without any Agent
 * membership. A public-membership-dependent group grant is not transferable. */
export async function privateGroupWorkProof(client: PoolClient,
  principalId: string): Promise<PrivateGroupProof | null> {
  const members = await client.query<{ id: string }>(`SELECT m.id
    FROM access.private_group_member m
    JOIN access.private_membership dep ON dep.id = m.private_membership_id
    JOIN access.recipient_group g ON g.id = m.group_id
    WHERE m.principal_id = $1 AND m.active AND g.scope_id = $2
      AND dep.principal_id = $1 AND dep.state = 'joined'
      AND dep.generation = m.private_membership_generation
    ORDER BY m.id LIMIT $3 FOR SHARE OF m, dep, g`,
  [principalId, SCOPE, MAX_GROUPS_PER_PRINCIPAL + 1]);
  if (members.rows.length > MAX_GROUPS_PER_PRINCIPAL) {
    throw new GroupUnavailable('private group membership exceeds supported profile');
  }
  if (!members.rows.length) return null;
  const gate = await client.query<{ group_generation: string }>(
    'SELECT group_generation FROM access.scope_gate WHERE id = $1 FOR SHARE', [SCOPE]);
  if (!gate.rows[0]) throw new GroupUnavailable('group scope is unavailable');
  const paths = await client.query<{ member_id: string; member_generation: string;
    grant_id: string | null; grant_generation: string | null; depth: number;
    parent_id: string | null; cycle: boolean }>(`
    WITH RECURSIVE path(member_id, member_generation, group_id, parent_id, depth, visited, cycle) AS (
      SELECT m.id, m.generation, g.id, g.parent_id, 0, ARRAY[g.id], false
      FROM access.private_group_member m JOIN access.recipient_group g ON g.id = m.group_id
      WHERE m.id = ANY($1::uuid[]) AND m.active AND g.scope_id = $2
      UNION ALL
      SELECT p.member_id, p.member_generation, g.id, g.parent_id, p.depth + 1,
        p.visited || g.id, g.id = ANY(p.visited)
      FROM path p JOIN access.recipient_group g ON g.id = p.parent_id
      WHERE p.depth < $3 AND NOT p.cycle AND g.scope_id = $2
    )
    SELECT p.member_id, p.member_generation, gr.id AS grant_id,
      gr.generation AS grant_generation, p.depth, p.parent_id, p.cycle
    FROM path p LEFT JOIN LATERAL (
      SELECT gr.id, gr.generation FROM access.group_permission_grant gr
      WHERE gr.group_id = p.group_id AND gr.scope_id = $2 AND gr.action = 'work.create'
        AND gr.active AND gr.valid_until > clock_timestamp() AND gr.membership_id IS NULL
      ORDER BY gr.id LIMIT 1
    ) gr ON true ORDER BY p.member_id, p.depth, gr.id`,
  [members.rows.map(row => row.id), SCOPE, MAX_DEPTH]);
  if (paths.rows.some(row => row.cycle || row.depth >= MAX_DEPTH && row.parent_id)) {
    throw new GroupUnavailable('private group ancestry exceeds supported profile');
  }
  const selected = paths.rows.find(row => row.grant_id !== null);
  return selected?.grant_id && selected.grant_generation ? {
    memberId: selected.member_id, memberGeneration: selected.member_generation,
    grantId: selected.grant_id, grantGeneration: selected.grant_generation,
    groupGeneration: gate.rows[0].group_generation,
  } : null;
}

export async function selectedPrivateGroupWorkProof(client: PoolClient,
  principalId: string, proof: PrivateGroupProof): Promise<boolean> {
  await privateGroupWorkProof(client, principalId); // enforce the same complete budget
  const gate = await client.query<{ group_generation: string }>(
    'SELECT group_generation FROM access.scope_gate WHERE id = $1 FOR SHARE', [SCOPE]);
  if (gate.rows[0]?.group_generation !== proof.groupGeneration) return false;
  const row = await client.query(`WITH RECURSIVE path(id, parent_id, depth, visited) AS (
    SELECT g.id, g.parent_id, 0, ARRAY[g.id]
    FROM access.private_group_member m
    JOIN access.private_membership dep ON dep.id = m.private_membership_id
    JOIN access.recipient_group g ON g.id = m.group_id
    WHERE m.id = $1 AND m.principal_id = $2 AND m.generation = $3 AND m.active
      AND dep.principal_id = $2 AND dep.state = 'joined'
      AND dep.generation = m.private_membership_generation AND g.scope_id = $6
    UNION ALL
    SELECT g.id, g.parent_id, p.depth + 1, p.visited || g.id
    FROM path p JOIN access.recipient_group g ON g.id = p.parent_id
    WHERE p.depth < $7 AND g.scope_id = $6 AND NOT g.id = ANY(p.visited)
  ) SELECT gr.id FROM path p JOIN access.group_permission_grant gr ON gr.group_id = p.id
    WHERE gr.id = $4 AND gr.generation = $5 AND gr.scope_id = $6
      AND gr.action = 'work.create' AND gr.active
      AND gr.valid_until > clock_timestamp() AND gr.membership_id IS NULL LIMIT 1`,
  [proof.memberId, principalId, proof.memberGeneration, proof.grantId,
    proof.grantGeneration, SCOPE, MAX_DEPTH]);
  return row.rowCount === 1;
}

export async function privateRoleWorkProof(client: PoolClient,
  principalId: string): Promise<PrivateRoleProof | null> {
  const rows = await client.query<{ id: string; generation: string; family_id: string;
    role_revision: string; permissions: string[] }>(`
    SELECT b.id, b.generation, b.family_id, b.role_revision, r.permissions
    FROM access.private_role_binding b
    JOIN access.private_membership dep ON dep.id = b.private_membership_id
    JOIN access.role_revision r ON r.family_id = b.family_id AND r.revision = b.role_revision
    WHERE b.principal_id = $1 AND b.active AND b.valid_until > clock_timestamp()
      AND dep.principal_id = $1 AND dep.state = 'joined'
      AND dep.generation = b.private_membership_generation
    ORDER BY b.id LIMIT $2 FOR SHARE OF b, dep`,
  [principalId, MAX_ROLES_PER_PRINCIPAL + 1]);
  if (rows.rows.length > MAX_ROLES_PER_PRINCIPAL) {
    throw new RoleUnavailable('private role bindings exceed supported profile');
  }
  const selected = rows.rows.find(row => row.permissions.includes('work.create'));
  return selected ? { bindingId: selected.id, bindingGeneration: selected.generation,
    familyId: selected.family_id, roleRevision: selected.role_revision } : null;
}

export async function selectedPrivateRoleWorkProof(client: PoolClient,
  principalId: string, proof: PrivateRoleProof): Promise<boolean> {
  await privateRoleWorkProof(client, principalId); // enforce the same complete budget
  const row = await client.query(`SELECT b.id FROM access.private_role_binding b
    JOIN access.private_membership dep ON dep.id = b.private_membership_id
    JOIN access.role_revision r ON r.family_id = b.family_id AND r.revision = b.role_revision
    WHERE b.id = $1 AND b.principal_id = $2 AND b.generation = $3
      AND b.family_id = $4 AND b.role_revision = $5 AND b.active
      AND b.valid_until > clock_timestamp() AND dep.principal_id = $2
      AND dep.state = 'joined' AND dep.generation = b.private_membership_generation
      AND r.permissions @> ARRAY['work.create']::text[] FOR SHARE OF b, dep`,
  [proof.bindingId, principalId, proof.bindingGeneration,
    proof.familyId, proof.roleRevision]);
  return row.rowCount === 1;
}
