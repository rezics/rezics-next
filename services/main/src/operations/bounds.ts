import type { Pool, PoolClient } from 'pg';

/** Numeric work bounds that Access admission, discovery and group management
 * enforce. The profile active in Access (migration 170) is the one every owner
 * reads, so all Main processes interpret saved grants under the same bounds. */
export interface OperationalBoundsProfile {
  id: string;
  /** Candidate acting subjects per principal before discovery is unavailable. */
  actingContexts: number;
  /** Parent edges a group ancestry path may climb. */
  groupDepth: number;
  /** Groups, and active group grants, per group scope. */
  groupsPerScope: number;
  /** Active group memberships per group scope. */
  membershipsPerScope: number;
  /** Active group memberships per Agent. */
  memberGroupsPerAgent: number;
  /** Active private group memberships per principal. */
  privateGroupsPerPrincipal: number;
  /** Active private role bindings per principal. */
  rolesPerPrincipal: number;
}

export type OperationalBound = Exclude<keyof OperationalBoundsProfile, 'id'>;

/** The profile this Main release requests at startup. */
export const ACCESS_OPERATIONAL_BOUNDS_V1: Readonly<OperationalBoundsProfile> = Object.freeze({
  id: 'access-operational-bounds-v1',
  actingContexts: 50,
  groupDepth: 32,
  groupsPerScope: 256,
  membershipsPerScope: 1024,
  memberGroupsPerAgent: 16,
  privateGroupsPerPrincipal: 16,
  rolesPerPrincipal: 16,
});

const BOUNDS: readonly OperationalBound[] = ['actingContexts', 'groupDepth', 'groupsPerScope',
  'membershipsPerScope', 'memberGroupsPerAgent', 'privateGroupsPerPrincipal', 'rolesPerPrincipal'];
const COLUMNS: Readonly<Record<OperationalBound, string>> = {
  actingContexts: 'acting_contexts', groupDepth: 'group_depth', groupsPerScope: 'groups_per_scope',
  membershipsPerScope: 'memberships_per_scope', memberGroupsPerAgent: 'member_groups_per_agent',
  privateGroupsPerPrincipal: 'private_groups_per_principal', rolesPerPrincipal: 'roles_per_principal',
};
const profileId = /^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]*$/;
/** Tables whose saved rows the bounds interpret; activation blocks their writers. */
const BOUNDED_TABLES = ['access.representation', 'access.principal_agent_attribution',
  'access.recipient_group', 'access.group_member', 'access.group_permission_grant',
  'access.private_group_member', 'access.private_role_binding'];

export class OperationalBoundsInvalid extends Error {}

export interface BoundViolation {
  bound: OperationalBound;
  /** Which saved records exceed the bound. */
  subject: 'principal-candidates' | 'group-ancestry' | 'groups' | 'group-grants'
    | 'scope-memberships' | 'agent-memberships' | 'principal-private-groups' | 'principal-roles';
  limit: number;
  /** Largest observed value, capped at limit + 1 for ancestry depth. */
  observed: number;
}

export interface BoundsAssessment {
  profile: string;
  violations: BoundViolation[];
}

/** `restricted`: the profile is enforced, and the listed saved records exceed it,
 * so the operations that read them are typed unavailable until migrated. */
export interface BoundsActivation {
  status: 'active' | 'restricted';
  profile: string;
  previous: string;
  reduced: OperationalBound[];
  violations: BoundViolation[];
  generation: string;
}

/** The public discovery response admits at most 50 contexts; raising this
 * bound needs that contract to change first. */
const PUBLIC_CONTEXT_CEILING = 50;

function validProfile(profile: OperationalBoundsProfile): void {
  if (!profileId.test(profile.id)
    || BOUNDS.some(bound => !Number.isSafeInteger(profile[bound]) || profile[bound] < 1)
    || profile.actingContexts > PUBLIC_CONTEXT_CEILING) {
    throw new OperationalBoundsInvalid('operational bounds profile is invalid');
  }
}

export type ProfileRow = { id: string } & Record<string, number | string | null>;

export function accessBoundsFromRow(row: ProfileRow): OperationalBoundsProfile {
  const profile = { id: row.id } as OperationalBoundsProfile;
  for (const bound of BOUNDS) profile[bound] = Number(row[COLUMNS[bound]]);
  return profile;
}

export const ACTIVE_ACCESS_BOUNDS_SQL = `SELECT p.* FROM access.operational_bounds_activation a
  JOIN access.operational_bounds_profile p ON p.id = a.profile_id WHERE a.singleton`;

/**
 * The active profile inside the caller's transaction: one primary-key read.
 * Mutations pass `lock` so a concurrent activation cannot reduce a bound
 * between their check and their commit. A missing activation is typed
 * unavailable through the owner's own error.
 */
export async function readAccessBounds(client: Pick<PoolClient, 'query'>,
  unavailable: (message: string) => Error, lock = false): Promise<OperationalBoundsProfile> {
  const result = await client.query<ProfileRow>(`${ACTIVE_ACCESS_BOUNDS_SQL}${lock ? ' FOR SHARE OF a' : ''}`);
  if (!result.rows[0]) throw unavailable('operational bounds profile is not activated');
  return accessBoundsFromRow(result.rows[0]);
}

/**
 * Cost: seven aggregate statements; representations/attributions, groups and
 * memberships each scan their active rows once (O(R log R) for grouping) and
 * ancestry climbs at most groupDepth + 1 edges from every group (O(G * D)).
 * Round trips are fixed whatever the saved-state size. Maintenance only.
 */
async function assess(client: Pick<PoolClient, 'query'>,
  candidate: OperationalBoundsProfile): Promise<BoundViolation[]> {
  const violations: BoundViolation[] = [];
  const candidates = await client.query<{ observed: string }>(`
    SELECT count(*)::text AS observed FROM (
      SELECT DISTINCT r.principal_id, r.subject_id AS subject FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
      WHERE r.action = 'work.create' AND r.active AND r.valid_until > clock_timestamp()
      UNION ALL
      SELECT DISTINCT a.principal_id, a.agent_subject FROM access.principal_agent_attribution a
      JOIN access.authority_subject s ON s.id = a.agent_subject AND s.kind = 'agent' AND s.active
      WHERE a.action = 'work.create' AND a.active AND a.valid_until > clock_timestamp()
    ) c GROUP BY principal_id HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1`,
  [candidate.actingContexts]);
  if (candidates.rows[0]) violations.push({ bound: 'actingContexts',
    subject: 'principal-candidates', limit: candidate.actingContexts,
    observed: Number(candidates.rows[0].observed) });
  // The same over-depth predicate as Access group proofs: a group reached at
  // depth >= limit that still has a parent, or a cycle, is beyond the profile.
  const ancestry = await client.query<{ over: boolean | null }>(`
    WITH RECURSIVE path(group_id, parent_id, scope_id, depth, visited, cycle) AS (
      SELECT g.id, g.parent_id, g.scope_id, 0, ARRAY[g.id], false FROM access.recipient_group g
      UNION ALL
      SELECT g.id, g.parent_id, p.scope_id, p.depth + 1, p.visited || g.id, g.id = ANY(p.visited)
      FROM path p JOIN access.recipient_group g ON g.id = p.parent_id AND g.scope_id = p.scope_id
      WHERE p.depth < $1 AND NOT p.cycle
    )
    SELECT bool_or(cycle OR (depth >= $1 AND parent_id IS NOT NULL)) AS over FROM path`,
  [candidate.groupDepth]);
  if (ancestry.rows[0]?.over) violations.push({ bound: 'groupDepth', subject: 'group-ancestry',
    limit: candidate.groupDepth, observed: candidate.groupDepth + 1 });
  const grouped = [
    { subject: 'groups' as const, bound: 'groupsPerScope' as const, sql: `
      SELECT count(*)::text AS observed FROM access.recipient_group
      GROUP BY scope_id HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1` },
    { subject: 'group-grants' as const, bound: 'groupsPerScope' as const, sql: `
      SELECT count(*)::text AS observed FROM access.group_permission_grant
      WHERE active AND valid_until > clock_timestamp()
      GROUP BY scope_id HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1` },
    { subject: 'scope-memberships' as const, bound: 'membershipsPerScope' as const, sql: `
      SELECT count(*)::text AS observed FROM access.group_member m
      JOIN access.recipient_group g ON g.id = m.group_id WHERE m.active
      GROUP BY g.scope_id HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1` },
    { subject: 'agent-memberships' as const, bound: 'memberGroupsPerAgent' as const, sql: `
      SELECT count(*)::text AS observed FROM access.group_member WHERE active
      GROUP BY agent_subject HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1` },
    { subject: 'principal-private-groups' as const, bound: 'privateGroupsPerPrincipal' as const, sql: `
      SELECT count(*)::text AS observed FROM access.private_group_member WHERE active
      GROUP BY principal_id HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1` },
    { subject: 'principal-roles' as const, bound: 'rolesPerPrincipal' as const, sql: `
      SELECT count(*)::text AS observed FROM access.private_role_binding
      WHERE active AND valid_until > clock_timestamp()
      GROUP BY principal_id HAVING count(*) > $1 ORDER BY count(*) DESC LIMIT 1` },
  ];
  for (const check of grouped) {
    const row = (await client.query<{ observed: string }>(check.sql,
      [candidate[check.bound]])).rows[0];
    if (row) violations.push({ bound: check.bound, subject: check.subject,
      limit: candidate[check.bound], observed: Number(row.observed) });
  }
  return violations;
}

/** Read-only assessment of saved Access state against any candidate profile. */
export async function assessOperationalBounds(pool: Pool,
  candidate: OperationalBoundsProfile): Promise<BoundsAssessment> {
  validProfile(candidate);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const violations = await assess(client, candidate);
    await client.query('COMMIT');
    return { profile: candidate.id, violations };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main startup activation of the requested profile. A profile identity is
 * immutable, so a changed bound needs a new identity. The requested profile
 * always becomes the enforced one: raising a bound cannot reinterpret a saved
 * grant, and reducing one never keeps the wider limit silently. When saved
 * records exceed a reduction, the activation is `restricted` and records them;
 * owners then return typed unavailable for exactly those records until the
 * operator migrates them and the next activation reassesses to `active`.
 *
 * Cost: an unchanged active profile is two primary-key reads. A change, or a
 * restricted profile, locks the activation row, then holds SHARE locks on the
 * bounded tables (blocking their writers, not readers) for one assessment.
 */
export async function activateOperationalBounds(pool: Pool,
  requested: OperationalBoundsProfile): Promise<BoundsActivation> {
  validProfile(requested);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    // Row first, then tables: writers take the row share lock before writing.
    const current = await client.query<{ profile_id: string; state: 'active' | 'restricted';
      generation: string }>(`SELECT profile_id, state, generation::text AS generation
      FROM access.operational_bounds_activation WHERE singleton FOR UPDATE`);
    const activation = current.rows[0];
    if (!activation) throw new OperationalBoundsInvalid('operational bounds activation is missing');
    const active = accessBoundsFromRow((await client.query<ProfileRow>(
      'SELECT * FROM access.operational_bounds_profile WHERE id = $1', [activation.profile_id])).rows[0]!);
    const stored = (await client.query<ProfileRow>(
      'SELECT * FROM access.operational_bounds_profile WHERE id = $1', [requested.id])).rows[0];
    if (stored && BOUNDS.some(bound => Number(stored[COLUMNS[bound]]) !== requested[bound])) {
      throw new OperationalBoundsInvalid('a changed operational bound needs a new profile identity');
    }
    const reduced = BOUNDS.filter(bound => requested[bound] < active[bound]);
    if (activation.profile_id === requested.id && activation.state === 'active') {
      await client.query('COMMIT');
      return { status: 'active', profile: requested.id, previous: active.id, reduced,
        violations: [], generation: activation.generation };
    }
    await client.query(`LOCK TABLE ${BOUNDED_TABLES.join(', ')} IN SHARE MODE`);
    const violations = await assess(client, requested);
    if (!stored) {
      await client.query(`INSERT INTO access.operational_bounds_profile
        (id, ${BOUNDS.map(bound => COLUMNS[bound]).join(', ')})
        VALUES ($1, ${BOUNDS.map((_, index) => `$${index + 2}`).join(', ')})`,
      [requested.id, ...BOUNDS.map(bound => requested[bound])]);
    }
    const status = violations.length ? 'restricted' as const : 'active' as const;
    const updated = await client.query<{ generation: string }>(`UPDATE access.operational_bounds_activation
      SET profile_id = $1, state = $2, violations = $3::jsonb, generation = generation + 1,
        updated_at = clock_timestamp() WHERE singleton RETURNING generation::text AS generation`,
    [requested.id, status, JSON.stringify(violations)]);
    await client.query('COMMIT');
    return { status, profile: requested.id, previous: active.id, reduced, violations,
      generation: updated.rows[0]!.generation };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
