import { CollectionSaveReview, type CollectionSaveReviewProps } from '../collection-save-review/review';

/** The curator review is a view of the exact ordered plan captured by Save. */
export function CollectionEditReview(props: CollectionSaveReviewProps) {
  return <CollectionSaveReview {...props} />;
}
