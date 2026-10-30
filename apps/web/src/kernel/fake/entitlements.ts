import type { BuyerEntitlement } from '../../checkout/entitlements';
import type { FakeRoute } from '../fake-modules';
import paid from '../recorded/order-paid.json';

export type EntitlementStoryMode =
  | 'active'
  | 'revoked'
  | 'legacy'
  | 'empty'
  | 'unavailable'
  | 'retry'
  | 'denied'
  | 'long'
  | 'preparing'
  | 'cursor-error';
let mode: EntitlementStoryMode = 'active';
let reads = 0;
export function setEntitlementStoryMode(next: EntitlementStoryMode) {
  mode = next;
  reads = 0;
}

// Typed page fixtures reuse the existing paid receipt and disclosed subject. These are not native evidence.
export const activeEntitlement: BuyerEntitlement = {
  id: paid.order.entitlementId,
  offerId: paid.order.offerId,
  orderId: paid.order.id,
  targetSubjectId: paid.order.targetSubjectId,
  contentEdition: null,
  summary: paid.order.subject,
  active: true,
  grantedAt: paid.order.createdAt,
  revokedAt: null,
  revokeReason: null,
};
export const revokedEntitlement: BuyerEntitlement = {
  ...activeEntitlement,
  active: false,
  revokedAt: '2026-10-29T08:31:42.000Z',
  revokeReason: 'refund',
};

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/entitlements(?:\/[^/]+)?$/,
    story: ({ request }) => {
      reads++;
      if (mode === 'denied') return { status: 404, code: 'not_found' };
      if (mode === 'unavailable' || (mode === 'retry' && reads === 1))
        return { status: 503, code: 'dependency_unavailable' };
      if (mode === 'preparing') return { status: 202 };
      if (mode === 'cursor-error') return { status: 409, code: 'stale_cursor' };
      const record =
        mode === 'revoked'
          ? revokedEntitlement
          : mode === 'legacy'
            ? { ...activeEntitlement, summary: null }
            : mode === 'long'
              ? {
                  ...activeEntitlement,
                  summary: {
                    ...paid.order.subject,
                    label: {
                      value:
                        'The Little Prince: annotated edition with historical notes, illustrations, translations and a very long descriptive title',
                      language: 'en',
                    },
                  },
                }
              : activeEntitlement;
      const url = new URL(request.url);
      if (url.pathname !== '/v1/entitlements') return { status: 200, entitlement: record };
      return {
        status: 200,
        entitlements: mode === 'empty' ? [] : [record],
        next: mode === 'active' && !url.searchParams.has('cursor') ? 'story-signed-cursor' : null,
      };
    },
  },
];
