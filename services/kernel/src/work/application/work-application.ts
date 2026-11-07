import type { WorkApplication, WorkApplicationPorts } from '../contract/index.ts';
import { createComposer } from './compose.ts';
import { createEnqueue } from './enqueue.ts';
import { createHistoryWork } from './history.ts';
import { createRetention } from './retention.ts';
import { createRetirement } from './retirement.ts';
import { createSelectedRuntime } from './selected-runtime.ts';

/** Use cases over Work-owned ports. Downstream implementations are never imported here. */
export function createWorkApplication(ports: WorkApplicationPorts): WorkApplication {
  const selected = createSelectedRuntime(ports);
  const enqueue = createEnqueue(ports);
  const composer = createComposer(ports, selected);
  const history = createHistoryWork(ports);
  const retirement = createRetirement(ports);
  const retention = createRetention(ports);
  return Object.freeze({
    ports,
    enqueue: enqueue.enqueue,
    hasRetainedCopies: enqueue.hasRetainedCopies,
    compose: composer.compose,
    composeSelectedRuntime: selected,
    selectedOperationalEnqueue: selected.selectedOperationalEnqueue,
    assertSelectedOperationalTransaction: selected.assertSelectedOperationalTransaction,
    selectedLocalQuery: selected.selectedLocalQuery,
    assertSelectedContinuation: selected.assertSelectedContinuation,
    openSelectedOperationalPhase: selected.openSelectedOperationalPhase,
    stageHistoryWork: history.stageHistoryWork,
    receiveHistoryWork: history.receiveHistoryWork,
    receiveMappedHistoryWork: history.receiveMappedHistoryWork,
    settleHistoryWork: history.settleHistoryWork,
    retireWriters: retirement.retireWriters,
    invokeRetirement: retirement.invokeRetirement,
    readRetirement: retirement.readRetirement,
    readWriterState: retirement.readWriterState,
    lockWriterState: retirement.lockWriterState,
    maintainOnce: retirement.maintainOnce,
    runRetentionBatch: retention.runRetentionBatch,
    runRetentionSweep: retention.runRetentionSweep,
    registerRetention: retention.registerRetention,
  });
}

export { SelectedRuntimeUnavailable } from './selected-runtime.ts';
export { WorkCompositionError } from './compose.ts';
export { createSelectedRuntime } from './selected-runtime.ts';
