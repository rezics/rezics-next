import type {
  WorkApplicationPorts,
  WorkEnqueueCapture,
  WorkIntent,
  WorkQueryClient,
  WorkSdkClient,
} from '../contract/index.ts';
import { assertWorkIntent } from '../core/index.ts';

export function createEnqueue(ports: Pick<WorkApplicationPorts, 'sdkEnqueue' | 'sql'>) {
  return {
    enqueue(
      client: WorkSdkClient,
      tx: WorkQueryClient,
      intent: WorkIntent,
      capture?: WorkEnqueueCapture,
    ): Promise<void> {
      assertWorkIntent(intent);
      return ports.sdkEnqueue.enqueueInTransaction(client, tx, intent, capture);
    },
    hasRetainedCopies(client: WorkQueryClient, workflowId: string): Promise<boolean> {
      return ports.sql.hasRetainedCopies(client, workflowId);
    },
  };
}
