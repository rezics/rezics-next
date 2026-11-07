import type { PoolClient } from 'pg';
import { nativeRequestTerminal } from './erasure-consumers.ts';
import { retireNativeRequest } from './application/index.ts';
import { nativeRequestRetentionStore } from './adapters/request-retention.ts';

/** Bind the original consumer in the caller's transaction. This is independent
 * of the workflow scan and never turns missing/partial evidence into cleanup.
 */
export function retireNativeWorkflowRequest(connection: PoolClient, workflowId: string): Promise<boolean> {
  return retireNativeRequest(
    {
      ...nativeRequestRetentionStore(connection),
      terminal: (id) => nativeRequestTerminal(connection, id),
    },
    workflowId,
  );
}
