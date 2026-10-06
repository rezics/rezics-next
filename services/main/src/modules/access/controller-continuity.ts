import type { PoolClient } from 'pg';
import { lockAccessKey } from './scope-gates.ts';
import { ControlConflict, ControlUnavailable } from './topology-control.ts';

export const CONTROLLER_CONTINUITY_COST = {
  maxSubjects: 256,
  controllerRowsPerSide: 17,
  policyLookupsPerSubject: 1,
} as const;

/** Serialize every controller-removing effect on the Agent, even without an
 * installed recovery policy. Acquire before reading a mandate that the effect
 * may revoke, avoiding shared-lock upgrades between concurrent removals.
 * Transaction advisory locks and fresh READ COMMITTED statements retain the
 * preceding removal's committed state:
 * https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS
 * https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED
 * (reviewed 2026-10-07). No Work, Definition or Space inventory is read. */
export async function lockControllerContinuity(
  client: PoolClient,
  subjects: readonly string[],
): Promise<void> {
  if (subjects.length > CONTROLLER_CONTINUITY_COST.maxSubjects) {
    throw new ControlUnavailable('controller change exceeds its subject budget');
  }
  for (const subject of [...new Set(subjects)].sort()) {
    await lockAccessKey(client, `controller-continuity:${subject}`);
  }
}

/** One invariant for all resource kinds: the steward Agent retains its control
 * floor. Reuse the owner's bounded, subject-indexed controller count and exact
 * recovery exception; an unconfigured Agent still keeps one controller. The
 * caller holds lockControllerContinuity through commit and checks AFTER its
 * effect so multiple removals and replacement in one transaction are judged
 * together. Cost per Agent: one policy lookup and at most 17 rows per side. */
export async function assertControllerContinuity(
  client: PoolClient,
  subjects: readonly string[],
): Promise<void> {
  for (const subject of [...new Set(subjects)].sort()) {
    const row = (
      await client.query<{ allowed: boolean }>(
        `WITH controllers AS MATERIALIZED (
      SELECT access.agent_controller_count($1) AS live) SELECT
      live >= COALESCE(
        (SELECT min_controllers FROM access.agent_control WHERE subject_id = $1), 1)
      OR (live >= 1 AND EXISTS (
        SELECT 1 FROM access.protected_change_activation WHERE target_subject = $1
          AND kind = 'agent-recovery' AND activation_txid = txid_current())) AS allowed
      FROM controllers`,
        [subject],
      )
    ).rows[0];
    if (!row?.allowed) throw new ControlConflict('change would break Agent control continuity');
  }
}

/** The principal row is already exclusively locked, so an assignment using a
 * live principal cannot race this indexed mandate inventory. This reads only
 * controller mandates, never the principal's resources or team membership. */
export async function principalControllerSubjects(
  client: PoolClient,
  principal: string,
): Promise<string[]> {
  const rows = (
    await client.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id
    FROM access.representation WHERE principal_id = $1 AND action = 'agent.control' AND active
    ORDER BY subject_id LIMIT $2`,
      [principal, CONTROLLER_CONTINUITY_COST.maxSubjects + 1],
    )
  ).rows;
  if (rows.length > CONTROLLER_CONTINUITY_COST.maxSubjects) {
    throw new ControlUnavailable('principal controller change exceeds its subject budget');
  }
  return rows.map((row) => row.subject_id);
}
