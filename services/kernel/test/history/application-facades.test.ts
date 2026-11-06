import { expect, test } from 'bun:test';
import { historyComposition, installHistoryComposition } from '../../src/history/application/composition.ts';
import { recordHistoryReceivingProof } from '../../src/history/application/receiving.ts';
import type { HistoryComposition } from '../../src/history/contract/ports.ts';

test('application facades delegate to whichever composition is installed', async () => {
  const native = historyComposition();
  const calls: string[] = [];
  // A fake capability set: every member records its name and yields nothing.
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
    installHistoryComposition(native);
  }
});
