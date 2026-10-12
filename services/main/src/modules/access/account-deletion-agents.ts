import type { PoolClient } from 'pg';
import { ControlConflict } from './topology-control.ts';

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

/** Same sorted object locks as every control change, without interpreting an
 * ordinary command's subject budget as a limit on account erasure. Only the
 * deleting principal's own indexed mandates are visited; no inventory of
 * resources or other principals is walked or returned to the application. */
export async function lockAccountDeletionAgents(client: PoolClient, principal: string): Promise<boolean> {
  const result = await client.query<{ count: string }>(`SELECT count(*)::text FROM (
    SELECT pg_advisory_xact_lock(hashtextextended('controller-continuity:' || subject_id, 0))
    FROM (SELECT DISTINCT subject_id FROM access.representation
      WHERE principal_id = $1 AND action = 'agent.control' AND active
      ORDER BY subject_id) controlled) locked`, [principal]);
  return Number(result.rows[0]?.count ?? '0') > 0;
}

/** The principal has just been fenced in this transaction. End provisioned
 * Persons; explicitly consented non-Persons stay under platform care. The
 * bounded response and the set-based effects have independent cardinalities.
 * A refusal rolls back these effects together with the principal fence. */
export async function applyAccountDeletionAgents(client: PoolClient, principal: string,
  operationId: string, options: AccountDeletionOptions): Promise<void> {
  const result = (await client.query<{ agents: AccountOwnedAgent[]; total: string }>(`
    WITH controlled AS MATERIALIZED (
      SELECT DISTINCT subject_id FROM access.representation
      WHERE principal_id = $1 AND action = 'agent.control' AND active
    ), ownerless AS MATERIALIZED (
      SELECT c.subject_id, coalesce(p.agent_kind, 'agent') AS kind, p.display_name
      FROM controlled c JOIN access.authority_subject s ON s.id = c.subject_id AND s.active
      LEFT JOIN access.agent_provision p ON p.agent_id = c.subject_id
      WHERE access.agent_controller_count(c.subject_id) = 0
    ), ended AS (
      UPDATE access.authority_subject s SET active = false, generation = generation + 1
      FROM ownerless o WHERE s.id = o.subject_id AND o.kind = 'person' RETURNING s.id
    ), orphaned AS (
      INSERT INTO access.account_deletion_orphan_agent
        (agent_id, deleted_principal_id, deleted_at, operation_id)
      SELECT subject_id, $1, clock_timestamp(), $2 FROM ownerless WHERE kind <> 'person' AND $3
      ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id
    )
    SELECT (SELECT count(*)::text FROM ownerless WHERE kind <> 'person') AS total,
      coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', subject_id, 'kind', kind, 'displayName', display_name)) ORDER BY subject_id)
        FROM (SELECT * FROM ownerless WHERE kind <> 'person' ORDER BY subject_id LIMIT 16) preview),
        '[]'::jsonb) AS agents`, [principal, operationId, options.leaveOwnedAgentsStanding === true])).rows[0]!;
  if (!options.leaveOwnedAgentsStanding && Number(result.total) > 0) {
    throw new AccountHasOwnedAgents(result.agents, Number(result.total));
  }
  // A fresh statement sees both authority endings and orphan rows. The shared
  // owner predicate also retains configured floors for Agents still controlled.
  const allowed = (await client.query<{ allowed: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM (SELECT DISTINCT subject_id FROM access.representation
      WHERE principal_id = $1 AND action = 'agent.control' AND active) controlled
    WHERE NOT access.agent_control_continuity_allowed(subject_id)) AS allowed`, [principal])).rows[0];
  if (!allowed?.allowed) throw new ControlConflict('change would break Agent control continuity');
}
