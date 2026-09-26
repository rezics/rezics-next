import type { Pool } from 'pg';

/** Numeric work bounds that Access admission and discovery enforce. Saved
 * grants are interpreted under one declared profile; the owner modules keep
 * their constants equal to it (checked by the IAM35 unit guard). */
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
}

export type OperationalBound = Exclude<keyof OperationalBoundsProfile, 'id'>;

export const ACCESS_OPERATIONAL_BOUNDS_V1: Readonly<OperationalBoundsProfile> = Object.freeze({
  id: 'access-operational-bounds-v1',
  actingContexts: 50,
  groupDepth: 32,
  groupsPerScope: 256,
  membershipsPerScope: 1024,
  memberGroupsPerAgent: 16,
});

const BOUNDS: readonly OperationalBound[] = ['actingContexts', 'groupDepth', 'groupsPerScope',
  'membershipsPerScope', 'memberGroupsPerAgent'];
const profileId = /^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]*$/;

export class OperationalBoundsInvalid extends Error {}
/** Saved Access state exceeds the candidate profile; activation must not proceed. */
export class OperationalBoundsBlocked extends Error {
  constructor(readonly violations: readonly BoundViolation[]) {
    super(`saved Access state exceeds ${violations.map(v => v.bound).join(', ')}`);
  }
}

export interface BoundViolation {
  bound: OperationalBound;
  /** Which saved records exceed the bound. */
  subject: 'principal-candidates' | 'group-ancestry' | 'groups' | 'group-grants'
    | 'scope-memberships' | 'agent-memberships';
  limit: number;
  /** Largest observed value, capped at limit + 1 for ancestry depth. */
  observed: number;
}

export interface BoundsAssessment {
  profile: string;
  violations: BoundViolation[];
}

export interface BoundsActivation {
  status: 'activated';
  profile: string;
  reduced: OperationalBound[];
}

function validProfile(profile: OperationalBoundsProfile): void {
  if (!profileId.test(profile.id)
    || BOUNDS.some(bound => !Number.isSafeInteger(profile[bound]) || profile[bound] < 1)) {
    throw new OperationalBoundsInvalid('operational bounds profile is invalid');
  }
}

/**
 * Maintenance read, never on an interactive path. Cost: one read-only snapshot
 * with five aggregate statements; principal candidates, groups and memberships
 * each scan their active rows once (O(R log R) for the grouping), and ancestry
 * climbs at most groupDepth + 1 edges from every group (O(G * D)). Round trips
 * stay fixed at eight regardless of saved-state size.
 */
export async function assessOperationalBounds(pool: Pool,
  candidate: OperationalBoundsProfile): Promise<BoundsAssessment> {
  validProfile(candidate);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
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
    const ancestry = await client.query<{ depth: number | null; over: boolean | null }>(`
      WITH RECURSIVE path(group_id, parent_id, scope_id, depth, visited, cycle) AS (
        SELECT g.id, g.parent_id, g.scope_id, 0, ARRAY[g.id], false FROM access.recipient_group g
        UNION ALL
        SELECT g.id, g.parent_id, p.scope_id, p.depth + 1, p.visited || g.id, g.id = ANY(p.visited)
        FROM path p JOIN access.recipient_group g ON g.id = p.parent_id AND g.scope_id = p.scope_id
        WHERE p.depth < $1 AND NOT p.cycle
      )
      SELECT max(depth) AS depth,
        bool_or(cycle OR (depth >= $1 AND parent_id IS NOT NULL)) AS over FROM path`,
    [candidate.groupDepth]);
    if (ancestry.rows[0]?.over) violations.push({ bound: 'groupDepth', subject: 'group-ancestry',
      limit: candidate.groupDepth, observed: candidate.groupDepth + 1 });
    const perScope = [
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
    ];
    for (const check of perScope) {
      const row = (await client.query<{ observed: string }>(check.sql,
        [candidate[check.bound]])).rows[0];
      if (row) violations.push({ bound: check.bound, subject: check.subject,
        limit: candidate[check.bound], observed: Number(row.observed) });
    }
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
 * Switch from the active profile to a candidate. Raising bounds cannot
 * reinterpret a saved grant; any reduction first assesses saved Access state
 * and refuses activation while a saved record would change meaning. The
 * operator migrates (revokes, regroups or splits) the reported records and
 * retries. The active profile stays in force on refusal.
 */
export async function activateOperationalBounds(pool: Pool, active: OperationalBoundsProfile,
  candidate: OperationalBoundsProfile): Promise<BoundsActivation> {
  validProfile(active);
  validProfile(candidate);
  const reduced = BOUNDS.filter(bound => candidate[bound] < active[bound]);
  if (reduced.length > 0 && candidate.id === active.id) {
    throw new OperationalBoundsInvalid('a reduced profile needs a new profile identity');
  }
  if (reduced.length > 0) {
    const { violations } = await assessOperationalBounds(pool, candidate);
    if (violations.length > 0) throw new OperationalBoundsBlocked(violations);
  }
  return { status: 'activated', profile: candidate.id, reduced };
}
