import type { Pool, PoolClient } from 'pg';
import { AUTH_WORKFLOW_APPLICATION, TERMINAL_WORKFLOW_STATUSES, WORKFLOW_RETENTION_WORKFLOW } from './retention.ts';

export type WorkflowRetentionCandidate = Readonly<{ id: string; eligible: boolean; technical: boolean }>;
type Cursor = { cutoff: string | null; through_key: string | null; after_key: string | null };
type RetirementCounts = { eligible: number; retired: number; pending: number };

async function cursor(connection: PoolClient): Promise<Cursor> {
  return (
    await connection.query<Cursor>(
      'SELECT cutoff,through_key,after_key FROM auth_workflow_retention WHERE singleton FOR UPDATE',
    )
  ).rows[0]!;
}

/** Persist the horizon before anything destructive. A process loss after an SDK commit
 * must replay under the original cutoff, even when no page checkpoint was reached.
 * Only one point-locked control row is read; no workflow population is counted.
 */
async function prepare(connection: PoolClient, cutoff: number): Promise<void> {
  await connection.query('BEGIN');
  try {
    const state = await cursor(connection);
    if (state.cutoff === null) {
      const last = (
        await connection.query<{ workflow_uuid: string }>(
          'SELECT workflow_uuid FROM auth_dbos.workflow_status ORDER BY workflow_uuid DESC LIMIT 1',
        )
      ).rows[0];
      await connection.query(
        'UPDATE auth_workflow_retention SET cutoff=$1,through_key=$2,after_key=NULL WHERE singleton',
        [cutoff, last?.workflow_uuid ?? null],
      );
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

/** Raw global PK examination uses the existing SDK identity index. There is no application,
 * completion or status predicate below LIMIT and no OFFSET, payload join, unbounded sort or child walk.
 * Foreign, recent and pending work all consume a raw slot. Eligibility is evaluated only
 * over this materialized page. New keys beyond the captured upper key wait for another sweep;
 * new keys behind the cursor are caught on the next sweep, as are recovered consumers.
 */
async function select(connection: PoolClient, state: Cursor, limit: number): Promise<WorkflowRetentionCandidate[]> {
  if (state.through_key === null) return [];
  const continuation = state.after_key === null ? '' : 'AND workflow_uuid > $6';
  const values: unknown[] = [
    state.through_key,
    limit,
    AUTH_WORKFLOW_APPLICATION,
    state.cutoff,
    [...TERMINAL_WORKFLOW_STATUSES],
  ];
  if (state.after_key !== null) values.push(state.after_key);
  return (
    await connection.query<WorkflowRetentionCandidate>(
      `WITH candidates AS MATERIALIZED (
         SELECT workflow_uuid,name,status,application_name,created_at,completed_at
         FROM auth_dbos.workflow_status
         WHERE workflow_uuid <= $1 ${continuation}
         ORDER BY workflow_uuid LIMIT $2
       )
       SELECT workflow_uuid AS id,
         COALESCE(application_name=$3 AND status=ANY($5::text[])
           AND completed_at < $4::bigint AND created_at < $4::bigint,false) AS eligible,
         name IN ('auth.maintenance.tick','${WORKFLOW_RETENTION_WORKFLOW}') AS technical
       FROM candidates ORDER BY workflow_uuid`,
      values,
    )
  ).rows;
}

/** The row lock serializes native/manual callers with scheduled retention. SDK and Auth
 * retirement own their transactions; this transaction owns only the continuation. On a
 * failure it rolls back that continuation, while already committed exact retirements stay
 * recoverable. No cursor row is an erasure receipt or a result-consumer acknowledgement.
 */
export async function examineWorkflowRetentionPage(
  database: Pool,
  proposedCutoff: number,
  limit: number,
  retire: (candidates: readonly WorkflowRetentionCandidate[]) => Promise<RetirementCounts>,
) {
  const connection = await database.connect();
  try {
    await prepare(connection, proposedCutoff);
    await connection.query('BEGIN');
    try {
      const state = await cursor(connection);
      // A concurrent caller can have drained the sweep between preparation and this lock.
      if (state.cutoff === null) {
        await connection.query('COMMIT');
        return { cutoff: proposedCutoff, examined: 0, eligible: 0, retired: 0, pending: 0, done: true };
      }
      const candidates = await select(connection, state, limit);
      const counts = await retire(candidates);
      const after = candidates.at(-1)?.id ?? state.after_key;
      const done = candidates.length < limit || after === state.through_key;
      await connection.query(
        `UPDATE auth_workflow_retention SET
           cutoff=$1,through_key=$2,after_key=$3 WHERE singleton`,
        done ? [null, null, null] : [state.cutoff, state.through_key, after],
      );
      await connection.query('COMMIT');
      return { cutoff: Number(state.cutoff), examined: candidates.length, ...counts, done };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  } finally {
    connection.release();
  }
}
