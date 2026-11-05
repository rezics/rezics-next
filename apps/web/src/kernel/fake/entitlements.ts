import type { BuyerEntitlement } from '../../checkout/entitlements';
import type { FakeRoute } from '../fake-modules';
import paid from '../recorded/order-paid.json';
import type { ContentEditionTerms } from '../../checkout/benefit';

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
export type MappedEntitlementStoryMode = 'mapped' | 'mapped-refunded' | 'mapped-disputed';
let mode: EntitlementStoryMode | MappedEntitlementStoryMode = 'active';
let reads = 0;
export function setEntitlementStoryMode(next: EntitlementStoryMode | MappedEntitlementStoryMode) {
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

// Constructed sanitized Commerce terms using the existing Content reader example's edition identity.
// These are presentation fixtures, not a recording, sale grant or native delivery proof.
export const fixedEditionTerms: ContentEditionTerms = {
  benefit: {
    kind: 'content-edition',
    resourceType: 'content.edition',
    resource: { route: 0, id: '0192f3a0-6c1e-7b2a-9d4e-000000000001' },
    version: { revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000003', sha256: 'a'.repeat(64) },
    action: 'edition:read',
  },
  creatorAccountId: '01a17a3a-20f5-72aa-9f14-f4cc56678188',
  targetSubjectId: paid.order.targetSubjectId,
  source: { licence: 'CC-BY-SA-4.0' },
  saleTermsReference: 'constructed-publication-1',
  delivery: 'fixed-content-edition',
  acquisition: 'one-time-account-bound',
  quantity: 1,
};
export const mappedEntitlement: BuyerEntitlement = { ...activeEntitlement, contentEdition: fixedEditionTerms };

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
        mode === 'mapped'
          ? mappedEntitlement
          : mode === 'mapped-refunded' || mode === 'mapped-disputed'
            ? {
                ...revokedEntitlement,
                contentEdition: fixedEditionTerms,
                revokeReason: mode === 'mapped-refunded' ? 'refund' : 'dispute',
              }
            : mode === 'revoked'
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
