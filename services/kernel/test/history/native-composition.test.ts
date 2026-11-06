import { expect, test } from 'bun:test';
import { historyComposition } from '../../src/history/application/composition.ts';
import { installNativeHistory, nativeHistoryComposition } from '../../src/composition/history.ts';
import { admitSharedHistory as nativeAdmitSharedHistory } from '../../src/history/adapters/shared-history.ts';
import { declareCommandHistory as nativeDeclareCommandHistory } from '../../src/history/adapters/record.ts';
import { recordDurableWorkLocator as nativeRecordDurableWorkLocator } from '../../src/history/adapters/record.ts';
import { advanceSelectedHistoryOriginal as nativeAdvanceSelectedHistoryOriginal } from '../../src/history/adapters/work.ts';

test('ordinary native composition binds the production adapters themselves', () => {
  installNativeHistory();
  const installed = historyComposition();
  const composed = nativeHistoryComposition();
  expect(installed.declareCommandHistory).toBe(nativeDeclareCommandHistory);
  expect(composed.recordDurableWorkLocator).toBe(nativeRecordDurableWorkLocator);
  expect(installed.admitSharedHistory).toBe(nativeAdmitSharedHistory);
  expect(composed.advanceSelectedHistoryOriginal).toBe(nativeAdvanceSelectedHistoryOriginal);
});
