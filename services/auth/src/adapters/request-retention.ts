import type { Pool, PoolClient } from 'pg';
import type { NativeRequestRetentionPorts } from '../contract/index.ts';

/** Uses the caller's already-open native copy transaction and exact row lock. */
export function nativeRequestRetentionStore(
  connection: PoolClient,
): Pick<NativeRequestRetentionPorts, 'lock' | 'remove'> {
  return {
    async lock(workflowId) {
      return (
        await connection.query<{ request_party_version: number; request_context_version: number }>(
          'SELECT request_party_version,request_context_version FROM auth_workflow_request WHERE workflow_id=$1 FOR UPDATE',
          [workflowId],
        )
      ).rows[0];
    },
    async remove(workflowId) {
      await connection.query('DELETE FROM auth_workflow_request WHERE workflow_id=$1', [workflowId]);
    },
  };
}

/** Install after DBOS launch. The owner trigger removes only source-authorized
 * request bindings inside the supported SDK deletion transaction, including rollback.
 */
export async function installWorkflowRequestRetention(database: Pool): Promise<void> {
  await database.query(`CREATE OR REPLACE TRIGGER auth_workflow_request_retention
    AFTER DELETE ON auth_dbos.workflow_status FOR EACH ROW
    EXECUTE FUNCTION public.auth_delete_workflow_request()`);
}
