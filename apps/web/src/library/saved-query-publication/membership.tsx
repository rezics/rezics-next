import { m } from '../../paraglide/messages.js';
import { CollectionPublicationReview, type PublicationReview } from '../collection-publication-review';
import { acceptedMeaningFromReview, type AcceptedPublicationMeaning } from './meaning';
import { publishedReviewSubjects, type PublishedMembership } from './published';

export function SavedQueryAcceptedMeaning({ meaning }: { meaning: AcceptedPublicationMeaning | null }) {
  if (!meaning) {
    return (
      <p className="max-w-prose text-sm text-muted-foreground" data-publication-meaning="unavailable">
        {m.library_publication_meaning_unavailable()}
      </p>
    );
  }
  return (
    <div
      className="max-w-prose space-y-1 text-sm"
      data-publication-meaning="ready"
      data-source-revision={meaning.revision}
    >
      <p className="font-medium">{m.library_publication_meaning()}</p>
      <p>{m.library_publication_revision({ revision: String(meaning.revision) })}</p>
      <p className="break-words">{meaning.title}</p>
      {meaning.description ? <p className="whitespace-pre-wrap break-words">{meaning.description}</p> : null}
    </div>
  );
}

export function SavedQueryPublishedMembership({
  published,
  review = null,
}: {
  published: PublishedMembership;
  review?: PublicationReview | null;
}) {
  const subjects = publishedReviewSubjects(review, published);
  return (
    <section className="space-y-2" aria-labelledby="publication-published" data-publication-published={published.state}>
      <h2 id="publication-published" className="text-xl font-semibold">
        {m.library_publication_published()}
      </h2>
      {published.state === 'unavailable' ? (
        <p role="status" className="max-w-prose text-sm text-muted-foreground">
          {m.library_publication_published_unavailable()}
        </p>
      ) : (
        <>
          <p role="status">{m.library_publication_published_generation({ generation: published.generation })}</p>
          <SavedQueryAcceptedMeaning meaning={acceptedMeaningFromReview(review)} />
          {review && subjects.length ? <CollectionPublicationReview review={{ ...review, subjects }} /> : null}
        </>
      )}
    </section>
  );
}
