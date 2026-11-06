import type { PrivacyReductionHead, PrivacyReductionObservation } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerStatus } from './public-filter-consumer-contract.ts';
import {
  admitQueryPrivacyHeads,
  observationIsDisclosable,
  queryPrivacyCurrentness,
  type QueryPrivacyDecision,
  type QueryPrivacyHeads,
} from './query-privacy.ts';

/**
 * Producer/consumer seam for trusted stale observations. Source blocking is the disclosure
 * barrier; diagnostic pending and changed lists do not withhold an ordinary permitted query.
 *
 * Cost
 * - Touches: one already-read privacy observation. No extra Source, engine or SQL.
 * - Bound: constant in the bounded blocking summaries already charged to the observation.
 * - Growth check: `test/search/query-privacy.test.ts` covers Source and consumer status shapes.
 */

export type QueryPrivacyObservedStatus = Extract<PrivacyReductionObservation, { status: 'observed' }>;
export type QueryPrivacyConsumerStatus = Extract<PublicFilterConsumerStatus, { status: 'observed' }>;

function headsFromObserved(observed: QueryPrivacyObservedStatus): QueryPrivacyHeads {
  return admitQueryPrivacyHeads({
    routingComplete: observed.routingComplete,
    unacknowledged: observed.unacknowledged,
    changed: observed.changed,
    blocking: observed.blocking,
  });
}

function headsFromConsumer(status: QueryPrivacyConsumerStatus): QueryPrivacyHeads {
  return admitQueryPrivacyHeads({
    routingComplete: true,
    unacknowledged: status.pending,
    changed: status.changed,
    blocking: status.blocking,
  });
}

export function queryPrivacyHeadsFromSource(observed: PrivacyReductionObservation): QueryPrivacyHeads | null {
  if (observed.status !== 'observed' || observed.coverage !== 'all_native_homes') return null;
  return headsFromObserved(observed);
}

export function queryPrivacyHeadsFromConsumer(status: PublicFilterConsumerStatus): QueryPrivacyHeads | null {
  if (status.status !== 'observed') return null;
  return headsFromConsumer(status);
}

export function sourceObservationIsDisclosable(
  observed: PrivacyReductionObservation,
): observed is QueryPrivacyObservedStatus {
  const heads = queryPrivacyHeadsFromSource(observed);
  return heads !== null && observationIsDisclosable(heads);
}

export function consumerObservationIsDisclosable(status: PublicFilterConsumerStatus): boolean {
  const heads = queryPrivacyHeadsFromConsumer(status);
  return heads !== null && observationIsDisclosable(heads);
}

export function sourceQueryPrivacyCurrentness(observed: PrivacyReductionObservation): QueryPrivacyDecision {
  const heads = queryPrivacyHeadsFromSource(observed);
  return heads === null
    ? { status: 'preparing', reason: observed.status === 'observed' ? 'routing_incomplete' : 'blocking' }
    : queryPrivacyCurrentness(heads);
}

export function consumerQueryPrivacyCurrentness(status: PublicFilterConsumerStatus): QueryPrivacyDecision {
  const heads = queryPrivacyHeadsFromConsumer(status);
  return heads === null ? { status: 'preparing', reason: 'blocking' } : queryPrivacyCurrentness(heads);
}

/** Shared predicate for capture, query, facet and suggestion disclosure. */
export function observationIsDisclosableFromUnknown(value: {
  routingComplete?: boolean;
  unacknowledged?: readonly PrivacyReductionHead[];
  pending?: readonly PrivacyReductionHead[];
  changed: readonly PrivacyReductionHead[];
  blocking: QueryPrivacyHeads['blocking'];
}): boolean {
  return observationIsDisclosable(
    admitQueryPrivacyHeads({
      routingComplete: value.routingComplete ?? true,
      unacknowledged: value.unacknowledged ?? value.pending ?? [],
      changed: value.changed,
      blocking: value.blocking,
    }),
  );
}
