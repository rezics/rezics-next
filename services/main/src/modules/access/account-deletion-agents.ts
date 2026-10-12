import type { PoolClient } from 'pg';
import { ControlConflict, ControlUnavailable } from './topology-control.ts';

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
    SELECT id FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE)
    SELECT id FROM access.scope_gate WHERE id = 'access:representation-topology'
      AND EXISTS (SELECT 1 FROM work) FOR UPDATE`);
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
      AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 17) e
  WHERE a.depth < 2
), candidates AS MATERIALIZED (
  SELECT DISTINCT subject_id FROM affected
)`;

// The principal is already fenced. Subtract only live edges from the proposed
// ending set from the owner's count; active foreign Person authorities count.
const endingControllers = `(SELECT count(*) FROM (
  SELECT 1 FROM access.representation_edge e
  JOIN access.authority_subject s ON s.id = e.representative_subject AND s.active
  WHERE e.represented_subject = c.subject_id AND e.action = 'agent.control'
    AND e.active AND e.valid_until > clock_timestamp()
    AND e.representative_subject = ANY(previous.subjects) LIMIT 17) ending_edges)`;

/** Same sorted object locks as every control change, without interpreting an
 * ordinary command's subject budget as a limit on account erasure. Only the
 * deleting principal's indexed mandates and bounded Person control paths are
 * visited; no resource inventory is walked or returned to the application. */
export async function lockAccountDeletionAgents(client: PoolClient, principal: string): Promise<boolean> {
  const result = await client.query<{ count: string }>(`${deletionInventory}
    SELECT count(*)::text FROM (
    SELECT pg_advisory_xact_lock(hashtextextended('controller-continuity:' || subject_id, 0))
    FROM (SELECT subject_id FROM candidates ORDER BY subject_id) controlled) locked`, [principal]);
  return Number(result.rows[0]?.count ?? '0') > 0;
}

/** The principal has just been fenced in this transaction. End provisioned
 * Persons; explicitly consented non-Persons stay under platform care. The
 * bounded response and the set-based effects have independent cardinalities.
 * A refusal rolls back these effects together with the principal fence. */
export async function applyAccountDeletionAgents(client: PoolClient, principal: string,
  operationId: string, options: AccountDeletionOptions): Promise<void> {
  const result = (await client.query<{ agents: AccountOwnedAgent[]; total: string; overflow: boolean }>(`
    ${deletionInventory}, ending_persons(subjects, settled) AS (
      SELECT ARRAY[]::text[], false
      UNION ALL
      SELECT next.subjects, next.subjects = previous.subjects FROM ending_persons previous
      CROSS JOIN LATERAL (SELECT coalesce(array_agg(c.subject_id ORDER BY c.subject_id), ARRAY[]::text[]) AS subjects
        FROM candidates c
        JOIN access.authority_subject s ON s.id = c.subject_id AND s.active
        JOIN access.agent_provision p ON p.agent_id = c.subject_id AND p.agent_kind = 'person'
        WHERE access.agent_controller_count(c.subject_id) = ${endingControllers}) next
      WHERE NOT previous.settled
    ), beyond_budget AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM ending_persons previous
        CROSS JOIN LATERAL unnest(previous.subjects) ended(subject_id)
        CROSS JOIN LATERAL (SELECT represented_subject FROM access.representation_edge
          WHERE representative_subject = ended.subject_id AND action = 'agent.control'
            AND active AND valid_until > clock_timestamp() LIMIT 17) e
        JOIN access.authority_subject s ON s.id = e.represented_subject AND s.active
        WHERE previous.settled AND NOT EXISTS (
          SELECT 1 FROM candidates c WHERE c.subject_id = e.represented_subject)) AS overflow
    ), ownerless AS MATERIALIZED (
      SELECT c.subject_id, coalesce(p.agent_kind, 'agent') AS kind, p.display_name
      FROM candidates c JOIN access.authority_subject s ON s.id = c.subject_id AND s.active
      LEFT JOIN access.agent_provision p ON p.agent_id = c.subject_id
      CROSS JOIN (SELECT subjects FROM ending_persons WHERE settled) previous
      WHERE access.agent_controller_count(c.subject_id) = ${endingControllers}
    ), ended AS (
      UPDATE access.authority_subject s SET active = false, generation = generation + 1
      FROM ownerless o WHERE s.id = o.subject_id AND o.kind = 'person' RETURNING s.id
    ), orphaned AS (
      INSERT INTO access.account_deletion_orphan_agent
        (agent_id, deleted_principal_id, deleted_at, operation_id)
      SELECT subject_id, $1, clock_timestamp(), $2 FROM ownerless WHERE kind <> 'person' AND $3
      ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id
    )
    SELECT (SELECT overflow FROM beyond_budget) AS overflow,
      (SELECT count(*)::text FROM ownerless WHERE kind <> 'person') AS total,
      coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', subject_id, 'kind', kind, 'displayName', display_name)) ORDER BY subject_id)
        FROM (SELECT * FROM ownerless WHERE kind <> 'person' ORDER BY subject_id LIMIT 16) preview),
        '[]'::jsonb) AS agents`, [principal, operationId, options.leaveOwnedAgentsStanding === true])).rows[0]!;
  // A bound must never let authority end outside the checked/locked inventory.
  if (result.overflow) throw new ControlUnavailable('account deletion exceeds its control-edge depth budget');
  if (!options.leaveOwnedAgentsStanding && Number(result.total) > 0) {
    throw new AccountHasOwnedAgents(result.agents, Number(result.total));
  }
  // A fresh statement sees both authority endings and orphan rows. The shared
  // owner predicate also retains configured floors for Agents still controlled.
  const allowed = (await client.query<{ allowed: boolean }>(`${deletionInventory}
    SELECT NOT EXISTS (
    SELECT 1 FROM candidates
    WHERE NOT access.agent_control_continuity_allowed(subject_id)) AS allowed`, [principal])).rows[0];
  if (!allowed?.allowed) throw new ControlConflict('change would break Agent control continuity');
}
