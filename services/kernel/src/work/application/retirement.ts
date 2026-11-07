import type {
  WorkApplicationPorts,
  WorkDispatchCost,
  WorkPool,
  WorkQueryClient,
  WorkRetirementInvocation,
  WorkSdkClient,
  WorkWriterState,
} from '../contract/index.ts';
import {
  SDK_MAINTENANCE_DISPATCH,
  SDK_RETIREMENT_DISPATCH,
  type SdkMaintenanceDispatch,
  type SdkRetirementDispatch,
} from '../contract/bounds.ts';

export function createRetirement(ports: Pick<WorkApplicationPorts, 'sdkRetirement' | 'history'>) {
  return {
    retireWriters(actualWorkflowId: string) {
      return ports.sdkRetirement.retireWorkflow(actualWorkflowId);
    },
    invokeRetirement(actualWorkflowId: string, client: WorkSdkClient, invocation: WorkRetirementInvocation) {
      if (!ports.sdkRetirement.supportsBoundedRetirement(client))
        throw new TypeError('SDK bounded workflow retirement is unavailable');
      return ports.sdkRetirement.invokeRetirement(actualWorkflowId, client, {
        deadline: invocation.deadline,
        maxAttempts: invocation.maxAttempts,
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        reserve: async (dispatch) => {
          const amount = SDK_RETIREMENT_DISPATCH[dispatch as SdkRetirementDispatch];
          if (!amount) throw new TypeError('Unpriced SDK retirement dispatch');
          await invocation.reserve(amount);
        },
      });
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
