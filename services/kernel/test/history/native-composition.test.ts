import { expect, test } from 'bun:test';
import { historyComposition } from '../../src/history/application/composition.ts';
import { nativeHistoryComposition } from '../../src/composition/history.ts';
import { declareCommandHistory as nativeDeclareCommandHistory } from '../../src/history/adapters/record.ts';
import { recordDurableWorkLocator as nativeRecordDurableWorkLocator } from '../../src/history/adapters/record.ts';

test('ordinary native composition binds the production adapters themselves', () => {
  expect(historyComposition().declareCommandHistory).toBe(nativeDeclareCommandHistory);
  expect(nativeHistoryComposition().recordDurableWorkLocator).toBe(nativeRecordDurableWorkLocator);
});
