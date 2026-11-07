import type { Pool } from 'pg';
import type { WorkflowRetentionStore, WorkflowRetentionCheckpoint } from './contract/index.ts';

/** Owns the control-row lock and transaction lifetime, never destructive effects.
 * One connection survives preparation and examination; each transaction releases
 * its lock at COMMIT. The application decides when a cursor is saved.
 */
export function workflowRetentionStore<Cursor>(database: Pool): WorkflowRetentionStore<Cursor> {
  return {
    async withSession(run) {
      const connection = await database.connect();
      const checkpoint: WorkflowRetentionCheckpoint<Cursor> = {
        async lock() {
          return (
            await connection.query<{ continuation: Cursor | null }>(
              'SELECT continuation FROM auth_workflow_retention WHERE singleton FOR UPDATE',
            )
          ).rows[0]!.continuation;
        },
        async save(continuation) {
          await connection.query('UPDATE auth_workflow_retention SET continuation=$1::jsonb WHERE singleton', [
            continuation === null ? null : JSON.stringify(continuation),
          ]);
        },
      };
      try {
        return await run({
          async transaction(body) {
            await connection.query('BEGIN');
            try {
              const result = await body(checkpoint);
              await connection.query('COMMIT');
              return result;
            } catch (error) {
              await connection.query('ROLLBACK');
              throw error;
            }
          },
        });
      } finally {
        connection.release();
      }
    },
  };
}
