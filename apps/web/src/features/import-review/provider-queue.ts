import type { ProviderDecisionRow, ProviderFailure, ProviderScope } from './provider-review-actions';

/** Temporary presentation port under the producer module name; these are view props, not a native DTO. */
export type ProviderQueueRow = ProviderDecisionRow;
export type ProviderQueuePage = {
  scope: ProviderScope;
  sourceLabel: string;
  contextLabel: string;
  statusLabel: string;
  rows: ProviderQueueRow[];
  session?: string;
};
export type ProviderQueueRead = ProviderFailure | { ok: true; page: ProviderQueuePage };

/** The declared review-candidates/derived preparation producer is unserved in this checkout. */
export async function readProviderQueue(): Promise<ProviderQueueRead> {
  return { ok: false, reason: 'unavailable' };
}
