import { PostReadingBody } from '../threads/post-reading-body';
import type { PublicationReview } from './contract';

/** This reader receives the submitted review, never the working editor or its media presentation. */
export function ArticlePublicationBody({
  review,
  isCurrent,
}: {
  review: PublicationReview;
  isCurrent: () => boolean;
}) {
  const snapshot = review.articleSnapshot;
  if (!snapshot) return null;
  return (
    <PostReadingBody
      document={snapshot.body}
      readerIdentity={review}
      isReaderCurrent={isCurrent}
      wideVisitKey={`studio-review:${review.entries[0]?.document.postId}:${review.entries[0]?.document.revisionId}`}
    />
  );
}
