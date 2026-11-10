import type { ReactNode } from 'react';
import {
  collectionComparisonFacts,
  collectionComparisonHref,
  type CollectionComparisonDefinitions,
} from './collection-comparison/model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CollectionListPresentations } from './collection-presentation';
import type { CollectionMember } from './reads';
import { displayRating } from '../features/pages/subject-ratings';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import {
  collectionViewerFactForMember,
  collectionViewerActionsState,
  collectionViewerHasPersonalAction,
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
  comparisonDefinitions,
  currentHref,
  onReferenceNavigate,
  referenceActions,
}: {
  member: Pick<CollectionMember, 'subject' | 'facts'> & { id?: string };
  listPresentations?: CollectionListPresentations | undefined;
  comparisonDefinitions?: CollectionComparisonDefinitions | undefined;
  currentHref?: string | undefined;
  onReferenceNavigate?: ((anchor: HTMLAnchorElement) => void) | undefined;
  referenceActions?: ((reference: { id: string; label: string; href: string }) => ReactNode) | undefined;
}) {
  if (!member.subject) return null;
  const locale = getLocale();
  const facts = collectionComparisonFacts(member, listPresentations, comparisonDefinitions, locale);
  const state =
    member.facts === undefined
      ? 'unknown'
      : facts.length
        ? 'supplied'
        : Object.values(member.facts).some((values) => values.length)
          ? 'unavailable'
          : 'empty';
  return (
    <>
      {member.subject.typeLabel ? <p className="text-sm text-muted-foreground">{member.subject.typeLabel}</p> : null}
      <div data-slot="member-list-row-facts" data-context-state={state} className="text-sm text-muted-foreground">
        {facts.length ? (
          <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
            {facts.map((fact, index) => (
              <div key={`${fact.property}:${index}`} data-property={fact.property} className="min-w-0 max-w-full">
                <dt lang={fact.label.lang} className="text-xs">
                  {fact.label.text || m.search_constraint_identity_property_unavailable()}
                </dt>
                <dd lang={fact.lang}>
                  {fact.targetId && (currentHref || referenceActions) ? (
                    <a
                      href={collectionComparisonHref(fact.targetId, fact.text, locale, currentHref, member.id)}
                      data-comparison-reference={fact.targetId}
                      className="relative z-10 inline-flex min-h-11 max-w-full items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      onClick={(event) => onReferenceNavigate?.(event.currentTarget)}
                    >
                      {fact.text}
                    </a>
                  ) : (
                    fact.text
                  )}
                  {fact.targetId
                    ? referenceActions?.({
                        id: fact.targetId,
                        label: fact.text,
                        href: collectionComparisonHref(fact.targetId, fact.text, locale, currentHref, member.id),
                      })
                    : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>
            {state === 'unknown'
              ? m.catalogue_context_unknown()
              : state === 'unavailable'
                ? m.catalogue_context_unavailable()
                : m.catalogue_context_absent()}
          </p>
        )}
        {facts.length && comparisonDefinitions === undefined ? <p>{m.catalogue_context_unavailable()}</p> : null}
      </div>
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
      {projection.state === 'current' ? (
        <p className="text-muted-foreground" data-viewer-actions={collectionViewerActionsState(row)}>
          {collectionViewerActionsState(row) === 'unavailable'
            ? m.collection_viewer_actions_unavailable()
            : !collectionViewerHasPersonalAction(row, question)
              ? m.collection_viewer_no_actions()
              : null}
        </p>
      ) : null}
      {actionHref && projection.state === 'current' && collectionViewerHasPersonalAction(row, question) ? (
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
