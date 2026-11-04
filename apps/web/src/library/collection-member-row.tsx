import { MetaLine } from '@rezics/ui/meta-line';
import { listKeyFacts } from '../media/type-presentation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CollectionListPresentations } from './collection-presentation';
import type { CollectionMember } from './reads';
import { displayRating } from '../features/pages/subject-ratings';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import {
  collectionViewerFactForMember,
  collectionViewerVoteCurrent,
  type CollectionViewerMember,
  type CollectionViewerProjection,
} from './collection-viewer/model';

export function CollectionMemberNoteSaved({ memberId }: { memberId: string }) {
  return (
    <span role="status" data-collection-note-saved={memberId} className="text-sm text-muted-foreground">
      {m.library_subject_saved()}
    </span>
  );
}

/** Only the supplied FULL facts and the member's actual released Type decide these details. */
export function CollectionMemberDetails({
  member,
  listPresentations,
}: {
  member: Pick<CollectionMember, 'subject' | 'facts'>;
  listPresentations?: CollectionListPresentations | undefined;
}) {
  if (!member.subject) return null;
  const facts = listKeyFacts(member.facts, listPresentations?.[member.subject.type]?.keyFacts, [], getLocale());
  return (
    <>
      {member.subject.typeLabel ? <p className="text-sm text-muted-foreground">{member.subject.typeLabel}</p> : null}
      {facts.length ? (
        <p data-slot="member-list-row-facts" className="text-sm text-muted-foreground">
          <MetaLine
            items={facts.map((fact, index) => (
              <span key={index} lang={fact.lang}>
                {fact.text}
              </span>
            ))}
          />
        </p>
      ) : null}
    </>
  );
}

function stateText(state: string, locale: string): string {
  switch (state) {
    case 'planned':
      return m.library_state_planned({}, { locale: locale as never });
    case 'in_progress':
      return m.library_state_in_progress({}, { locale: locale as never });
    case 'completed':
      return m.library_state_completed({}, { locale: locale as never });
    case 'paused':
      return m.library_state_paused({}, { locale: locale as never });
    case 'dropped':
      return m.library_state_dropped({}, { locale: locale as never });
    default:
      return m.library_other({}, { locale: locale as never });
  }
}

/** Personal Entry and score facts stay visually distinct from the curator note and public subject facts. */
export function CollectionMemberViewerDetails({
  member,
  projection,
  actionHref,
}: {
  member: CollectionViewerMember;
  projection: CollectionViewerProjection;
  actionHref?: string;
}) {
  if (!member.subject || (projection.state === 'withheld' && !actionHref)) return null;
  const locale = getLocale();
  const row = collectionViewerFactForMember(projection, member);
  const title = pageText(libraryTitleValue(member.subject.label), locale).text;
  const question = projection.state === 'current' ? projection.question : null;
  const currentVote = row && question && collectionViewerVoteCurrent(row, question);
  const hasCurrentRow = projection.state === 'current' && row !== undefined;
  return (
    <section
      aria-label={m.collection_viewer_heading()}
      data-slot="collection-viewer-facts"
      data-viewer-state={hasCurrentRow ? 'current' : 'unavailable'}
      className="space-y-1 border-t pt-2 text-sm"
    >
      <p className="font-medium">{m.collection_viewer_heading()}</p>
      {projection.state === 'unavailable' ? (
        <p className="text-muted-foreground">{m.collection_viewer_unavailable()}</p>
      ) : projection.state === 'current' ? (
        <>
          {!row || row.entry.state === 'unavailable' ? (
            <p className="text-muted-foreground">{m.collection_viewer_entry_unavailable()}</p>
          ) : row.entry.state === 'absent' ? (
            <p className="text-muted-foreground">{m.discovery_not_in_library()}</p>
          ) : (
            <p className="text-muted-foreground">
              {m.library_entry_state_label({
                title,
                state: stateText(row.entry.entryState ?? '', locale),
              })}
            </p>
          )}
          {!currentVote ? (
            <p className="text-muted-foreground">{m.collection_viewer_score_unavailable()}</p>
          ) : row!.vote.state === 'present' ? (
            <p className="text-muted-foreground" title={question!.meaning}>
              <span className="sr-only">{question!.meaning}: </span>
              {m.subject_ratings_yours({
                score: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
                  displayRating(row!.vote.units, question!.scale),
                ),
              })}
            </p>
          ) : (
            <p className="text-muted-foreground" title={question!.meaning}>
              <span className="sr-only">{question!.meaning}: </span>
              {m.subject_rating_control_unrated()}
            </p>
          )}
        </>
      ) : null}
      {actionHref ? (
        <a
          href={actionHref}
          className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.collection_viewer_action()}
        </a>
      ) : null}
    </section>
  );
}
