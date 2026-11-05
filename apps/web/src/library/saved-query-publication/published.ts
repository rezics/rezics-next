import { isRecord } from '../collection-records';
import type { PublicationComplete } from '../collection-publication';
import type { PublicationReview } from '../collection-publication-review';

/** Last complete selected-set only. Missing DTO support is never treated as an empty public set. */
export type PublishedMembership =
  | { state: 'unavailable' }
  | { state: 'complete'; generation: string; itemCount: number };

function completePublication(value: unknown): Extract<PublishedMembership, { state: 'complete' }> | null {
  if (!isRecord(value) || value.state !== 'complete' || typeof value.generation !== 'string' || !value.generation)
    return null;
  if (typeof value.itemCount !== 'number' || !Number.isSafeInteger(value.itemCount) || value.itemCount < 0) return null;
  return { state: 'complete', generation: value.generation, itemCount: value.itemCount };
}

/**
 * Collection GET and owner members pages have no published-set field today. A nested
 * `publication` object is used only when it is an exact complete native shape.
 */
export function publishedMembershipFromDto(collection: unknown): PublishedMembership {
  if (!isRecord(collection)) return { state: 'unavailable' };
  return completePublication(collection.publication) ?? { state: 'unavailable' };
}

export function publishedMembershipFromComplete(complete: PublicationComplete | null): PublishedMembership {
  return complete ? (completePublication(complete.publication) ?? { state: 'unavailable' }) : { state: 'unavailable' };
}

export function publishedMembership(
  complete: PublicationComplete | null,
  collection: unknown = null,
): PublishedMembership {
  const confirmed = publishedMembershipFromComplete(complete);
  return confirmed.state === 'complete' ? confirmed : publishedMembershipFromDto(collection);
}

/** Sealed review subjects are the confirmed selection; they are not current dynamic results. */
export function publishedReviewSubjects(review: PublicationReview | null, published: PublishedMembership) {
  if (published.state !== 'complete' || !review || review.subjects.length !== published.itemCount) return [];
  return review.subjects;
}
