import type { Pool, PoolClient } from 'pg';
import { AUTH_WORKFLOW_APPLICATION, WORKFLOW_RETENTION_WORKFLOW } from './retention.ts';
import {
  workflowStatusScan,
  type WorkflowStatusScanContinuation,
  type WorkflowStatusScanCopy,
} from './retention-scan.ts';

export type WorkflowRetentionCandidate = Readonly<{ id: string; eligible: boolean; technical: boolean }>;
type RetirementCounts = { eligible: number; retired: number; pending: number };

function technical(name: string) {
  return name === 'auth.maintenance.tick' || name === WORKFLOW_RETENTION_WORKFLOW;
}

function candidatesOf(copies: readonly WorkflowStatusScanCopy[]): WorkflowRetentionCandidate[] {
  return copies.map((copy) => ({ id: copy.workflowID, eligible: true, technical: technical(copy.workflowName) }));
}

async function lockedContinuation(connection: PoolClient): Promise<WorkflowStatusScanContinuation | null> {
  return (
    await connection.query<{ continuation: WorkflowStatusScanContinuation | null }>(
      'SELECT continuation FROM auth_workflow_retention WHERE singleton FOR UPDATE',
    )
  ).rows[0]!.continuation;
}

async function saveContinuation(connection: PoolClient, continuation: WorkflowStatusScanContinuation | null) {
  await connection.query('UPDATE auth_workflow_retention SET continuation=$1::jsonb WHERE singleton', [
    continuation === null ? null : JSON.stringify(continuation),
  ]);
}

/** Persist the SDK horizon before anything destructive. A process loss after an SDK commit
 * must replay under the original createdBefore and upper key, even when no page checkpoint
 * was reached. Only one point-locked control row is read; no workflow population is counted.
 */
async function prepare(connection: PoolClient, createdBefore: number, scan: ReturnType<typeof workflowStatusScan>) {
  await connection.query('BEGIN');
  try {
    if ((await lockedContinuation(connection)) === null) {
      const opened = await scan.openWorkflowStatusScan({
        applicationName: AUTH_WORKFLOW_APPLICATION,
        createdBefore,
      });
      if (opened.upperKey !== null) await saveContinuation(connection, opened);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

/** Raw examination uses the supported SDK scan. Foreign applications are outside that
 * producer. Live, recent and pending work consume raw slots; returned copies are already
 * terminal with completedAt <= createdBefore. Auth still owns consumer proof.
 */
export async function examineWorkflowRetentionPage(
  database: Pool,
  proposedCutoff: number,
  limit: number,
  retire: (candidates: readonly WorkflowRetentionCandidate[]) => Promise<RetirementCounts>,
) {
  const scan = workflowStatusScan();
  const connection = await database.connect();
  try {
    await prepare(connection, proposedCutoff, scan);
    await connection.query('BEGIN');
    try {
      const continuation = await lockedContinuation(connection);
      // A concurrent caller can have drained the sweep between preparation and this lock.
      if (continuation === null) {
        await connection.query('COMMIT');
        return { cutoff: proposedCutoff, examined: 0, eligible: 0, retired: 0, pending: 0, done: true };
      }
      const page = await scan.readWorkflowStatusScanPage(continuation, { rawLimit: limit });
      const counts = await retire(candidatesOf(page.copies));
      await saveContinuation(connection, page.exhausted ? null : page.continuation);
      await connection.query('COMMIT');
      return {
        cutoff: continuation.createdBefore,
        examined: page.examined,
        ...counts,
        done: page.exhausted,
      };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  } finally {
    connection.release();
  }
}
