import type { KernelClient } from '@rezics/client';

type Resource = ReturnType<NonNullable<KernelClient['libraryImports']['anilist']>>;
export type NativeLabelReviewBody = Parameters<NonNullable<Resource['$reviewLabels']>['post']>[0];
export type NativeLabelApplyBody = Parameters<NonNullable<Resource['$applyLabels']>['post']>[0];

/** Generated operands and routes; quote each original logical key only at the HTTP boundary. */
export function aniListLabelRequests(client: KernelClient, authorization: string) {
  const headers = { authorization };
  return {
    review(importId: string, body: NativeLabelReviewBody, key: string) {
      return client.libraryImports.anilist!({ importId }).$reviewLabels!.post(body, {
        headers: { ...headers, 'idempotency-key': JSON.stringify(key) },
      });
    },
    apply(importId: string, body: NativeLabelApplyBody) {
      return client.libraryImports.anilist!({ importId }).$applyLabels!.post(body, { headers });
    },
  };
}
