import { expect, test } from 'bun:test';
import { runCliAckRecoveryJourney } from './cli-ack-recovery-fixture.ts';

test('Ordinary operator exact ACK interruption and restart recovery', async () => {
  const r = await runCliAckRecoveryJourney();
  try {
    expect([1, 130]).toContain(r.interrupted.code);
    expect(r.interrupted.openHandles).toBe(0);
    expect(r.committedBeforeLoss.length).toBeGreaterThan(0);
    expect(r.pendingAfterClose.length).toBeGreaterThan(0);
    expect(r.resumed.code).toBe(0);
    expect(r.resumed.openHandles).toBe(0);
    expect(r.replayedBodies).toEqual(r.originalPendingBodies);
    expect(r.replayedKeys).toEqual(r.originalPendingKeys);
    expect(r.originalReceiptRowsAfter).toEqual(r.originalReceiptRowsBefore);
    expect(r.duplicateEffectRows).toEqual([]);
    expect(r.newerInputFirstEffectOrdinal).toBeGreaterThan(r.pendingDrainLastEffectOrdinal);
    expect(r.changedSuccessor.code).toBe(0);
    expect(r.changedProposalIds.length).toBeGreaterThan(0);
    expect(r.revokedReplay.status).toBe(403);
    expect(r.revokedReplay.storedSuccess).toBeNull();
    expect(r.originalBootstrapAfter).toEqual(r.originalBootstrapBefore);
    expect(r.independentSelectionAfter).toEqual(r.independentSelectionBefore);
  } finally {
    await r.close();
  }
}, 1_800_000);
