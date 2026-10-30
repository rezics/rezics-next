import { expect, test } from 'bun:test';
import { runCliKeyRotationJourney } from './cli-key-rotation-fixture.ts';

test('Operator key rotation and current authority during durable resume', async () => {
  const r = await runCliKeyRotationJourney();
  try {
    expect(r.pending.code).not.toBe(0);
    expect(r.oldKeyId).not.toBe(r.newKeyId);
    expect(r.accountAfter).toBe(r.accountBefore);
    expect(r.clientAfter).toBe(r.clientBefore);
    expect(r.oldKeySignIn.status).toBe(401);
    expect(r.newKeySignIn.status).toBe(200);
    expect(r.newToken.status).toBe(200);
    expect(r.newScopes).toEqual(r.originalScopes);
    expect(r.newScopes).not.toContain('media:complete');
    expect(r.revokedReplay.status).toBe(403);
    expect(r.revokedReplay.storedSuccess).toBeNull();
    expect(r.resumed.code).toBe(0);
    expect(r.resumedPreparedBytes).toEqual(r.originalPreparedBytes);
    expect(r.resumedPreparedKeys).toEqual(r.originalPreparedKeys);
    expect(r.originalReceiptRowsAfter).toEqual(r.originalReceiptRowsBefore);
    expect(r.duplicateEffectRows).toEqual([]);
    expect(r.unchanged.code).toBe(0);
    expect(r.unchangedPublicWrites).toEqual([]);
  } finally {
    await r.close();
  }
}, 1_800_000);
