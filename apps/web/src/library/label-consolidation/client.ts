import type { KernelClient } from '@rezics/client';

type Label = ReturnType<KernelClient['libraryLabels']>;
export type ReviewInput = Parameters<Label['$reviewConsolidation']['post']>[0];
export type ReviewPage = NonNullable<Awaited<ReturnType<Label['$reviewConsolidation']['post']>>['data']>;
export type ConfirmationInput = Parameters<Label['$confirmConsolidation']['post']>[0];
export type Confirmation = NonNullable<Awaited<ReturnType<Label['$confirmConsolidation']['post']>>['data']>;
export type ConsolidationResult = NonNullable<Awaited<ReturnType<Label['$applyConsolidation']['post']>>['data']>;
export type SelectedAssignment = ReviewInput['items'][number];

/** These functions require the existing private request envelope's current owner headers. */
export function consolidationClient(client: KernelClient, sourceLabelId: string, headers: Record<string, string>) {
  const label = client.libraryLabels({ id: sourceLabelId });
  const writeHeaders = (key: string) => ({ ...headers, 'idempotency-key': key });
  return {
    review: (body: ReviewInput) => label.$reviewConsolidation.post(body, { headers }),
    confirm: (body: ConfirmationInput, key: string) =>
      label.$confirmConsolidation.post(body, { headers: writeHeaders(key) }),
    apply: (confirmationId: string, key: string) =>
      label.$applyConsolidation.post({ confirmationId }, { headers: writeHeaders(key) }),
    retry: (confirmationId: string, item: number, key: string) =>
      label.$retryConsolidation.post({ confirmationId, item }, { headers: writeHeaders(key) }),
    cancel: (confirmationId: string, key: string) =>
      label.$cancelConsolidation.post({ confirmationId }, { headers: writeHeaders(key) }),
    result: (confirmationId: string) => label.consolidations({ confirmationId }).get({ headers }),
  };
}
