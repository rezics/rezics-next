import { expect, test } from 'bun:test';
import { historyComposition } from '../../src/history/application/composition.ts';
import { installNativeHistory, nativeHistoryComposition } from '../../src/composition/history.ts';
import { IDENTITY_HISTORY_COMMAND_CONTROL } from '../../src/history/adapters/agent-identity-inventory-work.ts';
import { withPrepaidAgentIdentityHistoryUnit as nativeWithPrepaid } from '../../src/history/adapters/agent-identity-retirement.ts';
import { historyExecutionPort as nativeHistoryExecutionPort } from '../../src/history/adapters/operational-work.ts';
import { prepareRecordHistoryPurge as nativePrepareRecordHistoryPurge } from '../../src/history/adapters/record-purge.ts';
import {
  declareCommandHistory as nativeDeclareCommandHistory,
  recordDurableWorkLocator as nativeRecordDurableWorkLocator,
} from '../../src/history/adapters/record.ts';
import { admitSharedHistory as nativeAdmitSharedHistory } from '../../src/history/adapters/shared-history.ts';
import { sharedHistoryWorkModule as nativeLocalSharedHistoryWorkModule } from '../../src/history/adapters/shared-history-work.ts';
import {
  advanceSelectedHistoryOriginal as nativeAdvanceSelectedHistoryOriginal,
  sharedHistoryWorkModule as nativeSharedHistoryWorkModule,
} from '../../src/history/adapters/work.ts';

test('ordinary native composition binds the production adapters themselves', () => {
  installNativeHistory();
  const installed = historyComposition();
  const composed = nativeHistoryComposition();
  expect(installed.declareCommandHistory).toBe(nativeDeclareCommandHistory);
  expect(composed.recordDurableWorkLocator).toBe(nativeRecordDurableWorkLocator);
  expect(installed.admitSharedHistory).toBe(nativeAdmitSharedHistory);
  expect(composed.advanceSelectedHistoryOriginal).toBe(nativeAdvanceSelectedHistoryOriginal);
  expect(installed.historyExecutionPort).toBe(nativeHistoryExecutionPort);
  expect(composed.prepareRecordHistoryPurge).toBe(nativePrepareRecordHistoryPurge);
  expect(installed.withPrepaidAgentIdentityHistoryUnit).toBe(nativeWithPrepaid);
  expect(composed.identityHistoryCommandControl).toBe(IDENTITY_HISTORY_COMMAND_CONTROL);
  expect(installed.sharedHistoryWorkModule).toBe(nativeSharedHistoryWorkModule);
  expect(installed.localSharedHistoryWorkModule).toBe(nativeLocalSharedHistoryWorkModule);
  expect(installed.localSharedHistoryWorkModule).not.toBe(installed.sharedHistoryWorkModule);
});
