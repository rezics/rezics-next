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
  sourceAdmitted: boolean;
  destinationAdmitted: boolean;
  membersAdmitted: boolean;
  state: 'reading' | 'ready' | 'unavailable';
}>;

export type CollectionTransferReviewState = 'review' | 'pending' | 'unknown' | 'refused' | 'confirmed' | null;

export type CollectionTransferDestinationReadback<T extends { id: string; revision: number }> = Readonly<{
  destination: T | undefined;
  membersAdmitted: boolean;
}>;

/** Source, destination header and destination membership settle separately; any miss keeps reconciliation unavailable. */
export function collectionTransferReadback(
  sourceId: string,
  destinationId: string,
  source: { id: string } | undefined,
  destination: { id: string } | undefined,
  membersAdmitted = false,
): CollectionTransferReceipt['state'] {
  return source?.id === sourceId && destination?.id === destinationId && membersAdmitted ? 'ready' : 'unavailable';
}

/** A source page counts only when its identity matches and members are currently readable. */
export function collectionTransferMatchedSource<T extends { id: string; memberState?: string | null }>(
  sourceId: string,
  source: T | undefined,
): T | undefined {
  return source?.id === sourceId && (source.memberState ?? 'ready') === 'ready' ? source : undefined;
}

/**
 * Destination identity comes from the header. A member page is admitted only after that header matches;
 * members-only success never invents a destination.
 */
export async function collectionTransferDestinationRead<T extends { id: string; revision: number }>(
  destinationId: string,
  header: Promise<T | null | undefined>,
  placements: (destination: T) => Promise<unknown>,
): Promise<CollectionTransferDestinationReadback<T>> {
  let target: T | null | undefined;
  try {
    target = await header;
  } catch {
    return { destination: undefined, membersAdmitted: false };
  }
  if (!target || target.id !== destinationId) return { destination: undefined, membersAdmitted: false };
  try {
    await placements(target);
    return { destination: target, membersAdmitted: true };
  } catch {
    return { destination: target, membersAdmitted: false };
  }
}

export function collectionTransferReceipt(
  review: CollectionTransferReview,
  sourceRevision: number,
  destinationRevision: number,
  state: CollectionTransferReceipt['state'] = 'reading',
): CollectionTransferReceipt {
  const admitted = state === 'ready';
  return {
    sourceId: review.sourceId,
    destinationId: review.destination.id,
    sourceTitle: review.sourceTitle,
    destinationTitle: review.destination.title,
    sourceHref: review.sourceHref,
    destinationHref: review.destinationHref,
    sourceRevision,
    destinationRevision,
    sourceAdmitted: admitted,
    destinationAdmitted: admitted,
    membersAdmitted: admitted,
    state,
  };
}

/** Keep each successful side's current revision; a miss leaves that side's captured revision unchanged. */
export function collectionTransferReceiptUpdate(
  receipt: CollectionTransferReceipt,
  source: { id: string; revision: number } | undefined,
  destination: { id: string; revision: number } | undefined,
  membersAdmitted = false,
): CollectionTransferReceipt {
  const sourceMatch = source?.id === receipt.sourceId ? source : undefined;
  const destinationMatch = destination?.id === receipt.destinationId ? destination : undefined;
  const admittedMembers = Boolean(destinationMatch) && membersAdmitted;
  return {
    ...receipt,
    sourceRevision: sourceMatch?.revision ?? receipt.sourceRevision,
    destinationRevision: destinationMatch?.revision ?? receipt.destinationRevision,
    sourceAdmitted: Boolean(sourceMatch),
    destinationAdmitted: Boolean(destinationMatch),
    membersAdmitted: admittedMembers,
    state: collectionTransferReadback(
      receipt.sourceId,
      receipt.destinationId,
      sourceMatch,
      destinationMatch,
      admittedMembers,
    ),
  };
}
