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
      className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-3 [overflow-wrap:anywhere]"
      data-publication-review
      data-source-revision={review.revision}
    >
      <p className="font-medium leading-snug">{review.title}</p>
      {review.description ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{review.description}</p> : null}
      {Number.isSafeInteger(review.revision) && review.revision > 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.library_publication_revision({ revision: String(review.revision) })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{m.library_publication_meaning_unavailable()}</p>
      )}
      <ol
        className="max-h-72 list-decimal space-y-1 overflow-auto overscroll-contain ps-6 pe-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        tabIndex={review.subjects.length > 6 ? 0 : undefined}
        aria-label={m.library_publication_choose()}
      >
        {review.subjects.map(({ id, label }) => {
          const title = displayLibraryTitle(label, locale);
          return (
            <li key={id}>
              <a
                className="inline-flex min-h-11 items-center py-2 text-primary underline underline-offset-4"
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
