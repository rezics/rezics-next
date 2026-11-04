import { expect, test } from 'bun:test';
import { benefitReaderHref, type CapturedBenefit } from '../src/checkout/benefit';
import {
  createPurchaseReaderOrigin,
  purchaseReaderOriginFromState,
  purchaseReaderOriginHref,
  purchaseReaderOriginIsCurrent,
} from '../src/checkout/purchase-return';

const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const history = { ordersCursor: 'orders/+?= &%#購入', entitlementsCursor: 'benefits/+?= &%#所有' };
const benefit = {
  kind: 'mapped',
  terms: { benefit: { resource: { id: editionId } } },
} as unknown as CapturedBenefit;

test('same-tab reader origin returns to the exact receipt or entitlement while canonical edition links stay private-data free', () => {
  for (const kind of ['order', 'entitlement'] as const) {
    const recordId = kind === 'order' ? 'order-0123' : 'entitlement-0456';
    const origin = createPurchaseReaderOrigin({
      kind,
      recordId,
      editionId,
      locale: 'ja',
      history,
      viewer: { current: true, subject: 'buyer-a', readId: 42 },
    })!;
    const restored = purchaseReaderOriginFromState({ purchaseOrigin: origin }, editionId, 'ja')!;
    const destination = new URL(purchaseReaderOriginHref(restored), 'https://site.test');

    expect(destination.pathname).toBe(`/ja/${kind === 'order' ? 'orders' : 'entitlements'}/${recordId}`);
    expect(destination.searchParams.get('ordersCursor')).toBe(history.ordersCursor);
    expect(destination.searchParams.get('entitlementsCursor')).toBe(history.entitlementsCursor);
    expect(purchaseReaderOriginIsCurrent(restored, editionId, 'ja', { current: true, subject: 'buyer-a', readId: 42 }))
      .toBe(true);

    const publicReader = benefitReaderHref(benefit, true, 'ja')!;
    expect(publicReader).toBe(`/ja/editions/${editionId}`);
    expect(publicReader).not.toContain(recordId);
    expect(publicReader).not.toContain('Cursor');
    expect(publicReader).not.toContain(history.ordersCursor);
    expect(publicReader).not.toContain(history.entitlementsCursor);
    expect(Object.keys(restored).sort()).toEqual([
      'editionId',
      'history',
      'kind',
      'locale',
      'recordId',
      'runtimeId',
      'version',
      'viewerReadId',
      'viewerSubject',
    ]);
  }
});

test('reader origin expires on runtime, address, viewer or admission replacement and rejects malformed positions', () => {
  const origin = createPurchaseReaderOrigin({
    kind: 'order',
    recordId: 'order-0123',
    editionId,
    locale: 'en',
    history,
    viewer: { current: true, subject: 'buyer-a', readId: 42 },
  })!;
  const state = { purchaseOrigin: origin };

  expect(purchaseReaderOriginFromState(state, `${editionId}-other`, 'en')).toBeUndefined();
  expect(purchaseReaderOriginFromState(state, editionId, 'fr')).toBeUndefined();
  expect(
    purchaseReaderOriginIsCurrent(origin, editionId, 'en', { current: false, subject: 'buyer-a', readId: 42 }),
  ).toBe(false);
  expect(
    purchaseReaderOriginIsCurrent(origin, editionId, 'en', { current: true, subject: 'buyer-a', readId: 43 }),
  ).toBe(false);
  expect(
    purchaseReaderOriginIsCurrent(origin, editionId, 'en', { current: true, subject: 'buyer-b', readId: 43 }),
  ).toBe(false);
  expect(
    purchaseReaderOriginIsCurrent(origin, editionId, 'en', { current: true, subject: 'buyer-a', readId: 44 }),
  ).toBe(false);
  expect(
    purchaseReaderOriginFromState(
      { purchaseOrigin: { ...origin, recordId: '/outside', history: { ordersCursor: 'x'.repeat(4097) } } },
      editionId,
      'en',
    ),
  ).toBeUndefined();
  expect(
    createPurchaseReaderOrigin({
      kind: 'entitlement',
      recordId: 'entitlement-0456',
      editionId,
      locale: 'en',
      viewer: { current: false, subject: 'buyer-a', readId: 42 },
    }),
  ).toBeUndefined();
});
