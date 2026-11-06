import type {
  WorkApplicationPorts,
  WorkDispatchCost,
  WorkPool,
  WorkQueryClient,
  WorkSdkClient,
  WorkWriterState,
} from '../contract/index.ts';
import { SDK_MAINTENANCE_DISPATCH, type SdkMaintenanceDispatch } from '../contract/index.ts';

export function createRetirement(ports: Pick<WorkApplicationPorts, 'sdkRetirement' | 'history'>) {
  return {
    retireWriters(actualWorkflowId: string) {
      return ports.sdkRetirement.retireWorkflow(actualWorkflowId);
    },
    readRetirement(actualWorkflowId: string) {
      return ports.sdkRetirement.readFence(actualWorkflowId);
    },
    readWriterState(actualWorkflowId: string, client: WorkSdkClient) {
      return ports.sdkRetirement.readWriterState(actualWorkflowId, client);
    },
    lockWriterState(tx: WorkQueryClient, expected: WorkWriterState, client: WorkSdkClient) {
      return ports.sdkRetirement.lockWriterState(tx, ports.history.commandPool(tx), expected, client);
    },
    maintainOnce(
      pool: WorkPool,
      client: WorkSdkClient,
      expected: WorkWriterState,
      action: 'retire' | 'delete',
      deadline: number,
      reserve: (cost: WorkDispatchCost) => Promise<void>,
    ) {
      if (!ports.sdkRetirement.supportsBoundedMaintenance(client))
        throw new TypeError('SDK bounded workflow maintenance is unavailable');
      return ports.sdkRetirement.maintainOnce(pool, client, expected, action, deadline, async (dispatch) => {
        const amount = SDK_MAINTENANCE_DISPATCH[dispatch as SdkMaintenanceDispatch];
        if (!amount) throw new TypeError('Unpriced SDK maintenance dispatch');
        await reserve(amount);
      });
    },
  };
}
