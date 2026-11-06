import { expect, test } from 'bun:test';
import { admitSharedHistory as accessAdmitSharedHistory } from '../../src/access/shared-history.ts';
import { sharedHistoryWorkModule as accessSharedHistoryWorkModule } from '../../src/access/shared-history-work.ts';
import { historyComposition, installHistoryComposition } from '../../src/history/application/composition.ts';
import {
  admitSharedHistory,
  localSharedHistoryWorkModule,
  recordHistoryReceivingProof,
} from '../../src/history/application/index.ts';
import type { HistoryComposition } from '../../src/history/contract/ports.ts';

function currentComposition(): HistoryComposition | undefined {
  try {
    return historyComposition();
  } catch {
    return undefined;
  }
}

test('application facades delegate to whichever composition is installed', async () => {
  const previous = currentComposition();
  const calls: string[] = [];
  const fake = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args: unknown[]) => (calls.push(String(name)), args),
    },
  ) as HistoryComposition;
  installHistoryComposition(fake);
  try {
    await recordHistoryReceivingProof(
      {} as never,
      {
        accountId: '00000000-0000-7000-8000-000000000000',
        accountRoute: 0,
        version: 1,
        at: '2026-01-01T00:00:00.000Z',
      },
      0,
      {} as never,
    );
    expect(calls).toEqual(['recordHistoryReceivingProof']);
  } finally {
    if (previous) installHistoryComposition(previous);
  }
});

test('calling a facade before installation throws', () => {
  const previous = currentComposition();
  try {
    installHistoryComposition(undefined as unknown as HistoryComposition);
    expect(() => historyComposition()).toThrow('History composition is not installed');
  } finally {
    if (previous) installHistoryComposition(previous);
  }
});

test('Access compatibility entries are the installed application facades', () => {
  expect(accessAdmitSharedHistory).toBe(admitSharedHistory);
  expect(accessSharedHistoryWorkModule).toBe(localSharedHistoryWorkModule);
});
