import { expect, test } from 'bun:test';
import { runCliNativeBackpressureJourney } from './cli-native-backpressure-fixture.ts';

test('Real public rate refusal and bounded operator resume', async () => {
  const r = await runCliNativeBackpressureJourney();
  try {
    expect(r.recovered.code).toBe(0);
    expect(r.nativeRateResponses.length).toBeGreaterThan(0);
    for (const response of r.nativeRateResponses) {
      expect(response.status).toBe(429);
      expect(response.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(r.actualScheduledWaits.length).toBeGreaterThan(0);
    expect(r.exhausted.code).toBe(1);
    expect(r.exhausted.openHandles).toBe(0);
    expect(r.completedBaselineAfterExhaustion).toEqual(r.completedBaselineBefore);
    expect(r.pendingPreparedBytes.length).toBeGreaterThan(0);
    expect(r.maxLogicalInvocationsForOneWrite).toBeLessThanOrEqual(8);
    expect(r.maxPhysicalSendsForOneWrite).toBeLessThanOrEqual(48);
    expect(r.resumed.code).toBe(0);
    expect(r.resumedBodies).toEqual(r.pendingPreparedBytes);
    expect(r.resumedKeys).toEqual(r.pendingPreparedKeys);
    expect(r.originalReceiptRowsAfter).toEqual(r.originalReceiptRowsBefore);
    expect(r.duplicateEffectRows).toEqual([]);
    expect(r.independentSelectionAfter).toEqual(r.independentSelectionBefore);
  } finally {
    await r.close();
  }
}, 1_800_000);
