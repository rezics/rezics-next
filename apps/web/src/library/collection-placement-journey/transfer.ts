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

/** A source page counts only when its identity matches and members are currently readable. */
export function collectionTransferMatchedSource<T extends { id: string; memberState?: string | null }>(
  sourceId: string,
  source: T | undefined,
): T | undefined {
  return source?.id === sourceId && (source.memberState ?? 'ready') === 'ready' ? source : undefined;
}

/** Destination identity comes from the header; a member page alone never invents a match. */
export async function collectionTransferDestinationRead<T extends { id: string; revision: number }>(
  destinationId: string,
  header: Promise<T | null | undefined>,
  placements: (destination: T) => Promise<unknown>,
): Promise<T | undefined> {
  const target = await header;
  if (!target || target.id !== destinationId) return undefined;
  await placements(target);
  return target;
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

/** Keep each successful side's current revision; a miss leaves that side's captured revision unchanged. */
export function collectionTransferReceiptUpdate(
  receipt: CollectionTransferReceipt,
  source: { id: string; revision: number } | undefined,
  destination: { id: string; revision: number } | undefined,
): CollectionTransferReceipt {
  const sourceMatch = source?.id === receipt.sourceId ? source : undefined;
  const destinationMatch = destination?.id === receipt.destinationId ? destination : undefined;
  return {
    ...receipt,
    sourceRevision: sourceMatch?.revision ?? receipt.sourceRevision,
    destinationRevision: destinationMatch?.revision ?? receipt.destinationRevision,
    state: collectionTransferReadback(receipt.sourceId, receipt.destinationId, sourceMatch, destinationMatch),
  };
}
