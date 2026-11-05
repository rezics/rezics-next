import type { CollectionMoveChoice } from './destination';

export type CollectionTransferOccurrence = Readonly<{ id: string; title: string }>;

export type CollectionTransferReview = CollectionMoveChoice &
  Readonly<{
    sourceId: string;
    sourceTitle: string;
    sourceRevision: number;
    sourceHref: string;
    destinationHref: string;
    occurrences: readonly CollectionTransferOccurrence[];
    memberIds: readonly string[];
    idempotencyKey: string;
  }>;

export type CollectionTransferReceipt = Readonly<{
  sourceId: string;
  destinationId: string;
  sourceTitle: string;
  destinationTitle: string;
  sourceHref: string;
  destinationHref: string;
  sourceRevision: number;
  destinationRevision: number;
  state: 'reading' | 'ready' | 'unavailable';
}>;

export type CollectionTransferReviewState = 'review' | 'pending' | 'unknown' | 'refused' | 'confirmed' | null;

/** Source and destination readbacks settle independently; either miss keeps reconciliation unavailable. */
export function collectionTransferReadback(
  sourceId: string,
  destinationId: string,
  source: { id: string } | undefined,
  destination: { id: string } | undefined,
): CollectionTransferReceipt['state'] {
  return source?.id === sourceId && destination?.id === destinationId ? 'ready' : 'unavailable';
}

export function collectionTransferReceipt(
  review: CollectionTransferReview,
  sourceRevision: number,
  destinationRevision: number,
  state: CollectionTransferReceipt['state'] = 'reading',
): CollectionTransferReceipt {
  return {
    sourceId: review.sourceId,
    destinationId: review.destination.id,
    sourceTitle: review.sourceTitle,
    destinationTitle: review.destination.title,
    sourceHref: review.sourceHref,
    destinationHref: review.destinationHref,
    sourceRevision,
    destinationRevision,
    state,
  };
}
