import type { PoolClient } from 'pg';
import { nativeRequestTerminal } from './erasure-consumers.ts';

/** Retire the private native request after its exact source consumer closes.
 * The caller retains the existing copy work/roles while SDK history is drained.
 * SDK status, request locators and historical missing context are not proofs. */
export async function retireNativeWorkflowRequest(connection: PoolClient, workflowId: string): Promise<boolean> {
  const row = (
    await connection.query<{ request_party_version: number; request_context_version: number }>(
      'SELECT request_party_version,request_context_version FROM auth_workflow_request WHERE workflow_id=$1 FOR UPDATE',
      [workflowId],
    )
  ).rows[0];
  if (!row || row.request_party_version !== 1 || row.request_context_version !== 1) return false;
  if (!(await nativeRequestTerminal(connection, workflowId))) return false;
  await connection.query('DELETE FROM auth_workflow_request WHERE workflow_id=$1', [workflowId]);
  return true;
}
