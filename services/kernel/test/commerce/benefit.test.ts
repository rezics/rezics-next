import { expect, test } from 'bun:test';
import {
  captureCurrentContentEdition,
  ContentEditionUnavailableError,
  decodeCapturedContentEdition,
  nativeEditionAuthorityAvailability,
  requireCurrentContentEdition,
  withoutUnverifiedBenefit,
} from '../../src/commerce/benefit.ts';
import type { CheckoutDecision } from '../../src/commerce/model.ts';
import { newId } from '../../src/route/route.ts';

test('the real missing Content producer has only a typed unavailable result', async () => {
  expect(nativeEditionAuthorityAvailability()).toEqual({
    kind: 'unavailable',
    reason: 'content-edition-sale-port-pending',
  });
  await expect(captureCurrentContentEdition(newId(0x2200))).rejects.toBeInstanceOf(ContentEditionUnavailableError);
  await expect(requireCurrentContentEdition(null)).rejects.toBeInstanceOf(ContentEditionUnavailableError);
});

test('historic mapping remains unknown and cannot be inferred from arbitrary bytes', () => {
  expect(decodeCapturedContentEdition(null)).toBeNull();
  for (const value of [{ targetSubjectId: newId(0x2200) }, { kind: 'content-edition' }, { body: 'x'.repeat(4096) }])
    expect(() => decodeCapturedContentEdition(JSON.stringify(value))).toThrow();
});

test('unavailable authority preserves paid truth/evidence and suppresses grant and restore only', () => {
  for (const kind of ['grant', 'restore'] as const) {
    const decision: CheckoutDecision = {
      changed: true,
      settlement: 'paid',
      paymentIntentId: 'pi_paid',
      observedAt: '2026-10-31T00:00:00Z',
      newTransactions: [],
      entitlement: { kind },
    };
    expect(withoutUnverifiedBenefit(decision)).toEqual({ ...decision, entitlement: { kind: 'none' } });
    expect(decision.entitlement.kind).toBe(kind);
  }
  for (const entitlement of [
    { kind: 'none' },
    { kind: 'revoke', reason: 'refund' },
    { kind: 'reason', reason: 'dispute' },
  ] as const) {
    const decision: CheckoutDecision = {
      changed: true,
      settlement: 'paid',
      paymentIntentId: 'pi_paid',
      observedAt: '2026-10-31T00:00:00Z',
      newTransactions: [],
      entitlement,
    };
    expect(withoutUnverifiedBenefit(decision)).toBe(decision);
  }
});
