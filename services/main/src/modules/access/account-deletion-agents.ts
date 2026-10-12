import type { PoolClient } from 'pg';
import { ControlConflict, ControlUnavailable } from './topology-control.ts';
import { CONTROLLER_CONTINUITY_COST } from './controller-continuity.ts';
import { MAX_EDGE_DEGREE } from './topology-schema.ts';

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

// One root page or one Person's outgoing edges per classification statement.
// Each candidate reads two foreign-principal ranges and one edge range, each
// bounded to 17 controllers; no prior level is scanned.
export const ACCOUNT_DELETION_CLASSIFICATION_COST = {
  subjectsPerStep: MAX_EDGE_DEGREE,
  controllerRowsPerStep: MAX_EDGE_DEGREE * CONTROLLER_CONTINUITY_COST.controllerRowsPerSide * 3,
} as const;

interface DeletionProgress {
  operation_id: string;
  classification_done: boolean;
  consent: boolean;
  orphan_count: number;
  steps: number;
  needs_boundary_check: boolean;
}

/** Start only when this principal has controller mandates. A retry retains
 * the original operation, root cursor, frontier and explicit consent. */
export async function collectAccountDeletionAgents(client: PoolClient, principal: string,
  operationId: string, options: AccountDeletionOptions): Promise<DeletionProgress | undefined> {
  return (await client.query<DeletionProgress>(`INSERT INTO access.account_deletion_progress
      (operation_id, principal_id, consent)
    SELECT $2, $1, $3 WHERE EXISTS (SELECT 1 FROM access.representation
      WHERE principal_id = $1 AND action = 'agent.control' AND active)
      OR EXISTS (SELECT 1 FROM access.account_deletion_progress WHERE principal_id = $1 AND NOT completed)
    ON CONFLICT (principal_id) DO UPDATE SET consent = access.account_deletion_progress.consent OR excluded.consent
    RETURNING operation_id, classification_done, consent, orphan_count, steps, needs_boundary_check`,
  [principal, operationId, options.leaveOwnedAgentsStanding === true])).rows[0];
}

/** Durable classification cuts at every surviving controller. Only affected
 * subjects acquire locks or enter the effect inventory. Expanding an ending
 * Person once also handles shortcuts: a child is reconsidered only when a new
 * ending parent reaches it, with indexed reads of its bounded incoming edges. */
async function classifyAccountDeletionStep(client: PoolClient, principal: string, progress: DeletionProgress):
  Promise<DeletionProgress> {
  const result = (await client.query<DeletionProgress & { fenced: boolean }>(`
    /* account_deletion_classification_step */
    WITH state AS MATERIALIZED (
      SELECT * FROM access.account_deletion_progress WHERE operation_id = $2
    ), roots AS MATERIALIZED (
      SELECT r.id, r.subject_id FROM access.representation r, state p
      WHERE NOT p.roots_done AND r.principal_id = $1 AND r.action = 'agent.control' AND r.active
        AND r.id >= coalesce(p.root_cursor, '00000000-0000-0000-0000-000000000000'::uuid)
        AND (p.root_cursor IS NULL OR r.id > p.root_cursor)
      ORDER BY r.id LIMIT ${ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep}
    ), awakened AS MATERIALIZED (
      SELECT f.agent_id, f.ctid FROM access.account_deletion_classification_frontier f, state p
      WHERE p.roots_done AND f.operation_id = $2 ORDER BY f.agent_id
      LIMIT ${ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep}
    ), parent AS MATERIALIZED (
      SELECT a.agent_id FROM access.account_deletion_progress_agent a, state p
      WHERE p.roots_done AND NOT EXISTS (SELECT 1 FROM awakened)
        AND a.operation_id = $2 AND a.effect = 'end' AND NOT a.expanded
      ORDER BY a.agent_id LIMIT 1
    ), children AS MATERIALIZED (
      SELECT e.represented_subject AS subject_id FROM parent p
      CROSS JOIN LATERAL (SELECT represented_subject FROM access.representation_edge
        WHERE representative_subject = p.agent_id AND action = 'agent.control' AND active
          AND valid_until > clock_timestamp() ORDER BY id LIMIT ${MAX_EDGE_DEGREE}) e
    ), candidates AS MATERIALIZED (
      SELECT subject_id FROM roots UNION SELECT agent_id FROM awakened UNION SELECT subject_id FROM children
    ), effects AS MATERIALIZED (
      SELECT c.subject_id, coalesce(p.agent_kind, 'agent') AS kind, n.remaining, n.controller_rows
      FROM candidates c CROSS JOIN LATERAL (SELECT id FROM access.authority_subject
        WHERE id = c.subject_id AND active LIMIT 1 OFFSET 0) s
      LEFT JOIN LATERAL (SELECT agent_kind FROM access.agent_provision
        WHERE agent_id = c.subject_id LIMIT 1 OFFSET 0) p ON true
      CROSS JOIN LATERAL access.account_deletion_remaining_controllers(c.subject_id, $1, $2) n
      WHERE NOT EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
        WHERE a.operation_id = $2 AND a.agent_id = c.subject_id)
    ), locks AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended('controller-continuity:' || subject_id, 0))
      FROM (SELECT subject_id FROM effects WHERE remaining = 0 ORDER BY subject_id) affected
    ), inserted AS (
      INSERT INTO access.account_deletion_progress_agent (operation_id, agent_id, effect, expanded, fenced)
      SELECT $2, e.subject_id, CASE WHEN e.kind = 'person' THEN 'end' ELSE 'orphan' END,
        e.kind <> 'person' OR NOT EXISTS (SELECT 1 FROM access.representation_edge
          WHERE representative_subject = e.subject_id AND action = 'agent.control'
            AND active AND valid_until > clock_timestamp()), true
      FROM effects e CROSS JOIN (SELECT count(*) FROM locks) locked WHERE e.remaining = 0
      RETURNING effect, expanded
    ), expanded AS (
      UPDATE access.account_deletion_progress_agent SET expanded = true
      WHERE operation_id = $2 AND agent_id IN (SELECT agent_id FROM parent)
    ), consumed AS (
      DELETE FROM access.account_deletion_classification_frontier
      WHERE ctid = ANY(ARRAY(SELECT ctid FROM awakened))
    ), next AS MATERIALIZED (
      SELECT p.roots_done OR (SELECT count(*) FROM roots) < $3 AS roots_done,
        NOT EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
          WHERE a.operation_id = $2 AND a.effect = 'end' AND NOT a.expanded
            AND a.agent_id NOT IN (SELECT agent_id FROM parent))
        AND NOT EXISTS (SELECT 1 FROM inserted WHERE effect = 'end' AND NOT expanded)
        AND NOT EXISTS (SELECT 1 FROM access.account_deletion_classification_frontier f
          WHERE f.operation_id = $2 AND f.agent_id NOT IN (SELECT agent_id FROM awakened)) AS frontier_done
      FROM state p
    ), advanced AS (
      UPDATE access.account_deletion_progress p
      SET root_cursor = coalesce((SELECT id FROM roots ORDER BY id DESC LIMIT 1), p.root_cursor),
        roots_done = n.roots_done, classification_done = n.roots_done AND n.frontier_done,
        orphan_count = p.orphan_count + (SELECT count(*) FROM inserted WHERE effect = 'orphan'),
        steps = p.steps + 1,
        needs_boundary_check = p.needs_boundary_check OR EXISTS (SELECT 1 FROM effects WHERE remaining > 0)
      FROM next n WHERE p.operation_id = $2
      RETURNING p.operation_id, p.classification_done, p.consent, p.orphan_count, p.steps, p.needs_boundary_check
    ) SELECT a.*, (SELECT count(*)::integer FROM effects) AS examined,
      (SELECT coalesce(sum(controller_rows), 0)::integer FROM effects) AS controller_rows,
      EXISTS (SELECT 1 FROM effects e
        CROSS JOIN LATERAL (SELECT operation_id FROM access.account_deletion_progress_agent
          WHERE agent_id = e.subject_id AND fenced LIMIT 1 OFFSET 0) a
        WHERE e.remaining = 0 AND a.operation_id <> $2) AS fenced
    FROM advanced a`, [principal, progress.operation_id, ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep])).rows[0]!;
  if (result.fenced) throw new ControlUnavailable('Account deletion control inventory is fenced');
  return result;
}

/** Orphan batches may commit separately. All Person pages run in the caller's
 * final transaction, which also deactivates the principal and publishes its fence. */
export async function applyAccountDeletionAgents(client: PoolClient, principal: string,
  initial: DeletionProgress): Promise<{ pending: boolean; checkBoundary: boolean }> {
  const progress = initial.classification_done ? initial : await classifyAccountDeletionStep(client, principal, initial);
  if (!progress.classification_done) return { pending: true, checkBoundary: true };
  const operationId = progress.operation_id;
  // A fresh one-step closure stays under the topology lock from its first
  // controller read through deactivation. Only cuts or prior commits need a recheck.
  const checkBoundary = progress.needs_boundary_check || initial.classification_done || initial.steps > 0;
  if (progress.orphan_count > 0 && !progress.consent) {
    const agents = (await client.query<AccountOwnedAgent>(`SELECT a.agent_id AS id,
      coalesce(p.agent_kind, 'agent') AS kind, p.display_name AS "displayName"
      FROM access.account_deletion_progress_agent a
      LEFT JOIN LATERAL (SELECT agent_kind, display_name FROM access.agent_provision
        WHERE agent_id = a.agent_id LIMIT 1 OFFSET 0) p ON true
      WHERE a.operation_id = $1 AND a.effect = 'orphan' ORDER BY a.agent_id LIMIT 16`, [operationId])).rows
      .map(agent => agent.displayName === null ? { id: agent.id, kind: agent.kind } : agent);
    // A refusal releases classification fences. No effect has been applied;
    // a later consent must classify fresh against then-current authority.
    for (const table of ['account_deletion_classification_frontier', 'account_deletion_progress_agent'] as const) {
      let removed: number;
      do {
        removed = (await client.query(`WITH page AS MATERIALIZED (
          SELECT ctid FROM access.${table} WHERE operation_id = $1 ORDER BY agent_id LIMIT 16
        ) DELETE FROM access.${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM page))`,
        [operationId])).rowCount ?? 0;
      } while (removed === 16);
    }
    await client.query('DELETE FROM access.account_deletion_progress WHERE operation_id = $1', [operationId]);
    await client.query('COMMIT');
    throw new AccountHasOwnedAgents(agents, progress.orphan_count);
  }
  if (progress.orphan_count > 0) {
    const batch = await client.query(`CREATE TEMP TABLE account_deletion_batch ON COMMIT DROP AS
      SELECT agent_id, ctid AS progress_tid FROM access.account_deletion_progress_agent
      WHERE operation_id = $1 AND effect = 'orphan' AND NOT completed
      ORDER BY agent_id LIMIT $2`, [operationId, CONTROLLER_CONTINUITY_COST.maxSubjects]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('controller-continuity:' || agent_id, 0))
      FROM (SELECT agent_id FROM account_deletion_batch ORDER BY agent_id) locked`);
    await client.query(`WITH orphaned AS (
      INSERT INTO access.account_deletion_orphan_agent (agent_id, deleted_principal_id, deleted_at, operation_id)
      SELECT agent_id, $1, clock_timestamp(), $2 FROM account_deletion_batch
      ON CONFLICT (agent_id) DO NOTHING
    ) UPDATE access.account_deletion_progress_agent SET completed = true
      WHERE ctid = ANY(ARRAY(SELECT progress_tid FROM account_deletion_batch))`, [principal, operationId]);
    if ((batch.rowCount ?? 0) === CONTROLLER_CONTINUITY_COST.maxSubjects) return { pending: true, checkBoundary };
  }
  // This loop deliberately does not commit. Its per-statement inventory stays
  // bounded, while every Person effect and principal deactivation remain atomic.
  let more: boolean;
  do {
    const result = (await client.query<{ count: string; retired: number; released: number }>(`WITH batch AS MATERIALIZED (
      SELECT agent_id, ctid FROM access.account_deletion_progress_agent
      WHERE operation_id = $1 AND effect = 'end' AND NOT completed ORDER BY agent_id LIMIT $2
    ), locks AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended('controller-continuity:' || agent_id, 0))
      FROM (SELECT agent_id FROM batch ORDER BY agent_id) locked
    ), ended AS (
      UPDATE access.authority_subject SET active = false, generation = generation + 1
      WHERE ctid = ANY(ARRAY(SELECT s.ctid FROM batch b
        CROSS JOIN LATERAL (SELECT ctid FROM access.authority_subject
          WHERE id = b.agent_id AND active LIMIT 1 OFFSET 0) s))
        AND (SELECT count(*) FROM locks) >= 0
    ), completed AS (
      UPDATE access.account_deletion_progress_agent SET completed = true, fenced = false
      WHERE ctid = ANY(ARRAY(SELECT ctid FROM batch))
    ), orphan_fences AS MATERIALIZED (
      SELECT agent_id, ctid FROM access.account_deletion_progress_agent
      WHERE operation_id = $1 AND effect = 'orphan' AND fenced ORDER BY agent_id LIMIT $2
    ), released AS (
      UPDATE access.account_deletion_progress_agent SET fenced = false
      WHERE ctid = ANY(ARRAY(SELECT ctid FROM orphan_fences)) RETURNING agent_id
    ), retired AS MATERIALIZED (
      SELECT access.retire_principal_controller_page($3, 16) AS count
    ), finished AS (
      UPDATE access.account_deletion_progress SET completed = true
      WHERE operation_id = $1 AND (SELECT count(*) FROM batch) < $2
        AND (SELECT count(*) FROM released) < $2 AND (SELECT count FROM retired) < 16
    ) SELECT count(*)::text AS count, (SELECT count FROM retired) AS retired,
      (SELECT count(*)::integer FROM released) AS released FROM batch`,
    [operationId, CONTROLLER_CONTINUITY_COST.maxSubjects, principal])).rows[0]!;
    more = Number(result.count) === CONTROLLER_CONTINUITY_COST.maxSubjects || result.retired === 16
      || result.released === CONTROLLER_CONTINUITY_COST.maxSubjects;
  } while (more);
  return { pending: false, checkBoundary };
}

/** Check surviving boundary subjects after the final effects, without walking
 * their descendants. Each statement reads one root page or one ending Person's
 * outgoing edges. A concurrent cut change can refuse, never strand a Person. */
export async function assertAccountDeletionContinuity(client: PoolClient, principal: string, operationId?: string): Promise<void> {
  let cursor = '';
  let count: number;
  do {
    const result = (await client.query<{ cursor: string; count: number; allowed: boolean }>(`WITH roots AS MATERIALIZED (
      SELECT id, subject_id FROM access.representation WHERE principal_id = $1 AND active
        AND action = 'agent.control' AND id >= coalesce(nullif($2, '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND ($2 = '' OR id > nullif($2, '')::uuid)
      ORDER BY id LIMIT $3
    ) SELECT (SELECT id::text FROM roots ORDER BY id DESC LIMIT 1) AS cursor,
      (SELECT count(*)::integer FROM roots) AS count,
      NOT EXISTS (SELECT 1 FROM roots WHERE NOT access.agent_control_continuity_allowed(subject_id)) AS allowed`,
    [principal, cursor, ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep])).rows[0]!;
    if (!result.allowed) throw new ControlConflict('change would break Agent control continuity');
    count = result.count;
    cursor = result.cursor;
  } while (count === ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep);
  if (!operationId) return;
  cursor = '';
  do {
    const result = (await client.query<{ cursor: string; count: number; allowed: boolean }>(`WITH parent AS MATERIALIZED (
      SELECT agent_id FROM access.account_deletion_progress_agent
      WHERE operation_id = $1 AND effect = 'end' AND agent_id > $2 ORDER BY agent_id LIMIT 1
    ), children AS MATERIALIZED (
      SELECT e.represented_subject FROM parent p
      CROSS JOIN LATERAL (SELECT represented_subject FROM access.representation_edge
        WHERE representative_subject = p.agent_id AND action = 'agent.control' AND active
          AND valid_until > clock_timestamp() ORDER BY id LIMIT ${MAX_EDGE_DEGREE}) e
    ) SELECT (SELECT agent_id FROM parent) AS cursor, (SELECT count(*)::integer FROM parent) AS count,
      NOT EXISTS (SELECT 1 FROM children WHERE NOT access.agent_control_continuity_allowed(represented_subject)) AS allowed`,
    [operationId, cursor])).rows[0]!;
    if (!result.allowed) throw new ControlConflict('change would break Agent control continuity');
    count = result.count;
    cursor = result.cursor;
  } while (count > 0);
}

/** Compatibility for operations whose principal was fenced by an older release. */
export async function continueAccountDeletionAgents(client: PoolClient, principal: string):
  Promise<{ operationId: string; pending: boolean } | null> {
  const progress = (await client.query<DeletionProgress>(`SELECT operation_id, classification_done, consent, orphan_count, steps, needs_boundary_check
    FROM access.account_deletion_progress WHERE principal_id = $1 AND NOT completed FOR UPDATE`, [principal])).rows[0];
  if (!progress) return null;
  return { operationId: progress.operation_id, pending: (await applyAccountDeletionAgents(client, principal, progress)).pending };
}

