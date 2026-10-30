import { expect, test } from 'bun:test';
import { runJourney } from './cli-midrun-authority-resume-fixture.ts';

test('an ordinary CLI stops safely on native mid-run bulk revocation and resumes its original sealed writes after authority restoration', async () => {
  const r = await runJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.denied.code).toBe(4);
    expect(r.denied.openHandles).toBe(0);
    expect(r.nativeDenials.length).toBeGreaterThan(0);
    for (const d of r.nativeDenials) expect(d.status).toBe(403);
    expect(r.completedBaselineAfterDenial).toEqual(r.completedBaselineBefore);
    expect(r.pendingBytes.length).toBeGreaterThan(0);
    expect(r.revokedReplay.status).toBe(403);
    expect(r.revokedReplay.storedSuccess).toBeNull();
    expect(r.resumed.code).toBe(0);
    expect(r.replayedBodies).toEqual(r.pendingBytes);
    expect(r.replayedKeys).toEqual(r.pendingKeys);
    expect(r.originalReceiptRowsAfter).toEqual(r.originalReceiptRowsBefore);
    expect(r.duplicateEffects).toEqual([]);
    expect(r.successor.code).toBe(0);
    expect(r.successorFirstEffect).toBeGreaterThan(r.pendingLastEffect);
    expect(r.independentSelectionAfter).toEqual(r.independentSelectionBefore);
  } finally {
    await r.close();
  }
}, 1_800_000);
