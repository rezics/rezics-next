import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { displayLibraryTitle } from './title';
import { publicationCandidates } from './collection-publication';
import type { DynamicCollectionPage } from './dynamic-collection';
import type { LibraryTitleLabel } from './reads';

/** Only public metadata and selected subject labels; no private facts, predicates or occurrence notes. */
export type PublicationReview = {
  title: string;
  description: string | null;
  revision: number;
  subjects: { id: string; label: LibraryTitleLabel }[];
};

export function publicationReview(
  page: DynamicCollectionPage,
  revision: number,
  selected: readonly string[],
): PublicationReview {
  const ids = new Set(selected);
  return {
    title: page.title,
    description: page.description,
    revision,
    // The selected-set producer emits unique canonical IDs in lexical order, independently of click order.
    subjects: publicationCandidates(page)
      .filter((member) => ids.has(member.subject!.id))
      .map((member) => {
        const { id, label } = member.subject!;
        return { id, label: typeof label === 'string' ? label : { ...label } };
      })
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
}

/** The dispatched review survives source refreshes, but never claims to be the active public generation. */
export function CollectionPublicationReview({ review }: { review: PublicationReview }) {
  const locale = getLocale();
  return (
    <div
      className="space-y-2 rounded-lg border border-border p-3"
      data-publication-review
      data-source-revision={review.revision}
    >
      <p className="font-medium break-words">{review.title}</p>
      {review.description ? <p className="whitespace-pre-wrap break-words">{review.description}</p> : null}
      {Number.isSafeInteger(review.revision) && review.revision > 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.library_publication_revision({ revision: String(review.revision) })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{m.library_publication_meaning_unavailable()}</p>
      )}
      <ol className="list-decimal space-y-1 ps-5" aria-label={m.library_publication_choose()}>
        {review.subjects.map(({ id, label }) => {
          const title = displayLibraryTitle(label, locale);
          return (
            <li key={id}>
              <a
                className="text-primary underline"
                href={subjectHref({ id, label: title.text }, locale).href}
                lang={title.lang}
              >
                {title.text}
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
