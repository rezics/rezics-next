import type { DynamicCollectionPage } from '../dynamic-collection';
import type { PublicationReview } from '../collection-publication-review';

/** Public metadata the selected-set command actually publishes. Release pins are not on this DTO. */
export type AcceptedPublicationMeaning = {
  revision: number;
  title: string;
  description: string | null;
};

export function acceptedMeaningFromReview(review: PublicationReview | null): AcceptedPublicationMeaning | null {
  if (!review || !Number.isSafeInteger(review.revision) || review.revision <= 0 || !review.title) return null;
  return { revision: review.revision, title: review.title, description: review.description };
}

export function acceptedMeaningFromPage(
  page: Pick<DynamicCollectionPage, 'title' | 'description'> | null,
  revision: number,
): AcceptedPublicationMeaning | null {
  if (!page || !Number.isSafeInteger(revision) || revision <= 0 || !page.title) return null;
  return { revision, title: page.title, description: page.description };
}
