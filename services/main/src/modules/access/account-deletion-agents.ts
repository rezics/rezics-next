import type { PoolClient } from 'pg';
import { ControlConflict, ControlUnavailable } from './topology-control.ts';
import { CONTROLLER_CONTINUITY_COST } from './controller-continuity.ts';
import { MAX_EDGE_DEGREE, MAX_PATH_EDGES } from './topology-schema.ts';

export interface AccountDeletionOptions {
  leaveOwnedAgentsStanding?: boolean;
}

export interface AccountOwnedAgent {
  id: string;
  kind: string;
  displayName?: string;
}

export class AccountHasOwnedAgents extends Error {
  readonly code = 'account_has_owned_agents';
  readonly hasMore: boolean;
  readonly moreCount: number;

  constructor(readonly agents: AccountOwnedAgent[], total: number) {
    super('Account deletion requires consent to leave owned Agents standing without a controller');
    this.moreCount = Math.max(0, total - agents.length);
    this.hasMore = this.moreCount > 0;
  }
}

/** Freeze the edge inventory before locking the principal. Controller changes
 * take Work, topology, principal, then the Agent locks in this same order. */
export async function lockAccountDeletionTopology(client: PoolClient): Promise<void> {
  await client.query(`WITH work AS MATERIALIZED (
    SELECT id FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE),
    topology AS MATERIALIZED (
      SELECT id FROM access.scope_gate WHERE id = 'access:representation-topology'
        AND EXISTS (SELECT 1 FROM work) FOR UPDATE)
    SELECT id FROM topology OFFSET 1`);
  // Consume the singleton lock row without returning inventory to the caller.
}

// Visit only this principal's mandates and the bounded outgoing control edges
// of its Person authorities. Non-Persons remain active, so their outgoing edges
// cannot lose authority through this deletion. Use the same inventory for locks,
// hypothetical classification and the fresh post-effect continuity check.
const deletionInventory = `WITH RECURSIVE controlled AS MATERIALIZED (
  SELECT DISTINCT subject_id FROM access.representation
  WHERE principal_id = $1 AND action = 'agent.control' AND active
), affected(subject_id, depth) AS (
  SELECT subject_id, 0 FROM controlled
  UNION
  SELECT e.represented_subject, a.depth + 1 FROM affected a
  JOIN access.agent_provision p ON p.agent_id = a.subject_id AND p.agent_kind = 'person'
  CROSS JOIN LATERAL (SELECT represented_subject FROM access.representation_edge
    WHERE representative_subject = a.subject_id AND action = 'agent.control'
      AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT ${MAX_EDGE_DEGREE}) e
  WHERE a.depth < ${MAX_PATH_EDGES}
)
SELECT subject_id, min(depth)::integer AS depth FROM affected GROUP BY subject_id`;

// The principal is already fenced. Subtract only live edges from the proposed
// ending set from the owner's count; active foreign Person authorities count.
const endingControllers = `(SELECT count(*) FROM (
  SELECT 1 FROM access.representation_edge e
  JOIN access.authority_subject s ON s.id = e.representative_subject AND s.active
  WHERE e.represented_subject = c.subject_id AND e.action = 'agent.control'
    AND e.active AND e.valid_until > clock_timestamp()
    AND e.representative_subject = ANY(previous.subjects) LIMIT ${CONTROLLER_CONTINUITY_COST.controllerRowsPerSide}) ending_edges)`;

/** Same sorted object locks as every control change, without interpreting an
 * ordinary command's subject budget as a limit on account erasure. Only the
 * deleting principal's indexed mandates and bounded Person control paths are
 * visited; no resource inventory is walked or returned to the application. */
export async function lockAccountDeletionAgents(client: PoolClient, principal: string): Promise<boolean> {
  // Keep the closure in PostgreSQL: one indexed recursive inventory, reused by
  // classification and effects, with no population-sized application response.
  const result = await client.query(`CREATE TEMP TABLE account_deletion_candidates ON COMMIT DROP AS
    ${deletionInventory}`, [principal]);
  return (result.rowCount ?? 0) > 0;
}

const candidateLocks = `SELECT pg_advisory_xact_lock(
  hashtextextended('controller-continuity:' || subject_id, 0))
  FROM (SELECT subject_id FROM account_deletion_candidates ORDER BY subject_id
    LIMIT ${CONTROLLER_CONTINUITY_COST.maxSubjects}) locked`;

/** Classify against the fenced principal before committing any effects. A large
 * closure becomes a durable operation; retries use its inventory and consent.
 * Its controller inventory is fenced until the bounded effects finish. */
export async function applyAccountDeletionAgents(client: PoolClient, principal: string,
  operationId: string, options: AccountDeletionOptions): Promise<boolean> {
  await client.query(`CREATE TEMP TABLE account_deletion_effects ON COMMIT DROP AS
    WITH RECURSIVE locks AS MATERIALIZED (${candidateLocks}),
    candidates AS (SELECT * FROM account_deletion_candidates),
    ending_persons(subjects, settled) AS (
      SELECT ARRAY[]::text[], false
      UNION ALL
      SELECT next.subjects, next.subjects = previous.subjects FROM ending_persons previous
      CROSS JOIN LATERAL (SELECT coalesce(array_agg(c.subject_id ORDER BY c.subject_id), ARRAY[]::text[]) AS subjects
        FROM candidates c
        JOIN access.authority_subject s ON s.id = c.subject_id AND s.active
        JOIN access.agent_provision p ON p.agent_id = c.subject_id AND p.agent_kind = 'person'
        WHERE access.agent_controller_count(c.subject_id) = ${endingControllers}) next
      WHERE NOT previous.settled
    )
    SELECT c.subject_id, coalesce(p.agent_kind, 'agent') AS kind, p.display_name,
      c.depth, access.agent_controller_count(c.subject_id) - ${endingControllers} AS remaining
    FROM candidates c JOIN access.authority_subject s ON s.id = c.subject_id AND s.active
    LEFT JOIN access.agent_provision p ON p.agent_id = c.subject_id
    CROSS JOIN (SELECT subjects FROM ending_persons WHERE settled) previous
    CROSS JOIN (SELECT count(*) FROM locks) locked`);
  const result = (await client.query<{ agents: AccountOwnedAgent[]; total: string; count: string; allowed: boolean; fenced: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
      JOIN access.account_deletion_progress p USING (operation_id)
      JOIN account_deletion_candidates c ON c.subject_id = a.agent_id
      WHERE NOT p.completed) AS fenced, count(*)::text AS count,
      count(*) FILTER (WHERE remaining = 0 AND kind <> 'person')::text AS total,
      coalesce(bool_and(remaining = 0 OR access.agent_control_continuity_allowed(subject_id)
        AND remaining >= coalesce((SELECT min_controllers FROM access.agent_control
          WHERE subject_id = e.subject_id), 1)
        OR EXISTS (SELECT 1 FROM access.account_deletion_orphan_agent WHERE agent_id = e.subject_id)), true) AS allowed,
      coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', subject_id, 'kind', kind, 'displayName', display_name)) ORDER BY subject_id)
        FROM (SELECT * FROM account_deletion_effects WHERE remaining = 0 AND kind <> 'person'
          ORDER BY subject_id LIMIT 16) preview), '[]'::jsonb) AS agents
    FROM account_deletion_effects e`)).rows[0]!;
  if (result.fenced) throw new ControlUnavailable('Account deletion control inventory is fenced');
  if (!options.leaveOwnedAgentsStanding && Number(result.total) > 0) {
    throw new AccountHasOwnedAgents(result.agents, Number(result.total));
  }
  if (!result.allowed) throw new ControlConflict('change would break Agent control continuity');
  if (Number(result.count) > CONTROLLER_CONTINUITY_COST.maxSubjects) {
    await client.query(`INSERT INTO access.account_deletion_progress (operation_id, principal_id)
      VALUES ($1, $2)`, [operationId, principal]);
    await client.query(`INSERT INTO access.account_deletion_progress_agent
      (operation_id, agent_id, depth, effect)
      SELECT $1, subject_id, depth, CASE WHEN remaining <> 0 THEN 'keep'
        WHEN kind = 'person' THEN 'end' ELSE 'orphan' END FROM account_deletion_effects`, [operationId]);
    return true;
  }
  await client.query(`WITH ended AS (
    UPDATE access.authority_subject s SET active = false, generation = generation + 1
    FROM account_deletion_effects e WHERE s.id = e.subject_id AND e.remaining = 0 AND e.kind = 'person'
    RETURNING s.id
  ) INSERT INTO access.account_deletion_orphan_agent
    (agent_id, deleted_principal_id, deleted_at, operation_id)
    SELECT subject_id, $1, clock_timestamp(), $2 FROM account_deletion_effects
    WHERE remaining = 0 AND kind <> 'person' ON CONFLICT (agent_id) DO NOTHING`, [principal, operationId]);
  const allowed = (await client.query<{ allowed: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM account_deletion_candidates
    WHERE NOT access.agent_control_continuity_allowed(subject_id)) AS allowed`)).rows[0];
  if (!allowed?.allowed) throw new ControlConflict('change would break Agent control continuity');
  return false;
}

/** Caller holds recovery, topology and principal locks. Complete deepest
 * subjects first so ending a Person cannot strand an unprocessed descendant.
 * The progress row and each effect commit together, including no-op subjects. */
export async function continueAccountDeletionAgents(client: PoolClient, principal: string):
  Promise<{ operationId: string; pending: boolean } | null> {
  const progress = (await client.query<{ operation_id: string }>(`SELECT operation_id
    FROM access.account_deletion_progress WHERE principal_id = $1 AND NOT completed FOR UPDATE`, [principal])).rows[0];
  if (!progress) return null;
  const operationId = progress.operation_id;
  await client.query(`CREATE TEMP TABLE account_deletion_batch ON COMMIT DROP AS
    SELECT agent_id, effect FROM access.account_deletion_progress_agent
    WHERE operation_id = $1 AND NOT completed ORDER BY depth DESC, agent_id
    LIMIT $2`, [operationId, CONTROLLER_CONTINUITY_COST.maxSubjects]);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('controller-continuity:' || agent_id, 0))
    FROM (SELECT agent_id FROM account_deletion_batch ORDER BY agent_id) locked`);
  await client.query(`WITH ended AS (
    UPDATE access.authority_subject s SET active = false, generation = generation + 1
    FROM account_deletion_batch b WHERE s.id = b.agent_id AND b.effect = 'end' AND s.active RETURNING s.id
  ), orphaned AS (
    INSERT INTO access.account_deletion_orphan_agent
      (agent_id, deleted_principal_id, deleted_at, operation_id)
    SELECT agent_id, $1, clock_timestamp(), $2 FROM account_deletion_batch WHERE effect = 'orphan'
    ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id
  ) UPDATE access.account_deletion_progress_agent p SET completed = true
    FROM account_deletion_batch b WHERE p.operation_id = $2 AND p.agent_id = b.agent_id`, [principal, operationId]);
  const allowed = (await client.query<{ allowed: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM account_deletion_batch WHERE NOT access.agent_control_continuity_allowed(agent_id)) AS allowed`)).rows[0];
  if (!allowed?.allowed) throw new ControlConflict('change would break Agent control continuity');
  const pending = (await client.query<{ pending: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM access.account_deletion_progress_agent WHERE operation_id = $1 AND NOT completed) AS pending`,
  [operationId])).rows[0]!.pending;
  if (!pending) await client.query(`UPDATE access.account_deletion_progress SET completed = true
    WHERE operation_id = $1`, [operationId]);
  return { operationId, pending };
}
