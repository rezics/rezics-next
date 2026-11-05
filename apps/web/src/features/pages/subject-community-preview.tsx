import { m } from '../../paraglide/messages.js';
import type { ReactionKind } from '../../threads/reaction-request';
import { subjectHref } from '../../subject/subject-href';
import { PublicReplyParent } from '../feed/card-attribution';
import type { CommunityKind, CommunityReactionFreshness, CommunityThread } from './subject-community';
import { CommunityRecordedCitation } from './subject-community-card-view';

const reactionLabels: Record<ReactionKind, (locale: string) => string> = {
  upvote: (locale) => m.reaction_upvote({}, { locale: locale as never }),
  downvote: (locale) => m.reaction_downvote({}, { locale: locale as never }),
  like: (locale) => m.reaction_like({}, { locale: locale as never }),
  love: (locale) => m.reaction_love({}, { locale: locale as never }),
  laugh: (locale) => m.reaction_laugh({}, { locale: locale as never }),
  insightful: (locale) => m.reaction_insightful({}, { locale: locale as never }),
  sad: (locale) => m.reaction_sad({}, { locale: locale as never }),
};

function ReadOnlyReactionCounts({
  thread,
  locale,
  reactionsAsOf,
}: {
  thread: CommunityThread;
  locale: string;
  reactionsAsOf: CommunityReactionFreshness;
}) {
  if (thread.reactions === undefined || reactionsAsOf == null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.subject_reactions_unavailable({}, { locale: locale as never })}
      </p>
    );
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const entries = (Object.keys(reactionLabels) as ReactionKind[])
    .map((kind) => [kind, thread.reactions?.[kind] ?? 0] as const)
    .filter(([, count]) => count > 0);
  if (!entries.length)
    return (
      <p className="text-sm text-muted-foreground">
        {m.subject_community_reactions_none({}, { locale: locale as never })}
      </p>
    );
  return (
    <div data-slot="community-reaction-summary" className="space-y-1 text-sm text-muted-foreground">
      <ul aria-label={m.reaction_reactions({}, { locale: locale as never })} className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([kind, count]) => (
          <li key={kind}>
            {reactionLabels[kind](locale)} {format(count)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keeps read-only counts; incomplete citation provenance stays unavailable instead of borrowing current context. */
export function SubjectCommunityPreview({
  kind,
  thread,
  locale,
  reader,
  reactionsAsOf,
}: {
  kind: CommunityKind;
  thread: CommunityThread;
  subject: { id: string; label: string };
  locale: string;
  reader: string | null;
  reactionsAsOf: CommunityReactionFreshness;
}) {
  const options = { locale: locale as never };
  const target = thread.reviewTarget;
  const citation = thread.voteCitation;
  const recorded = thread.card?.citation;
  return (
    <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]" data-slot="subject-community-preview">
      <p className="text-sm text-muted-foreground" data-slot="community-licence">
        {m.thread_history_licence({}, options)}: <bdi>{thread.licence}</bdi>
      </p>
      {kind === 'review' ? (
        <>
          {target?.state === 'available' ? (
            <p data-slot="community-review-target" className="text-sm">
              <a
                href={
                  subjectHref(
                    { id: target.subject.id, label: target.subject.label?.value ?? target.subject.id },
                    locale,
                  ).href
                }
                lang={target.subject.label?.language}
                className="inline-flex min-h-11 min-w-11 items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <bdi>
                  {m.thread_review_details_selected_subject(
                    { title: target.subject.label?.value ?? target.subject.id },
                    options,
                  )}
                </bdi>
              </a>
            </p>
          ) : (
            <p data-slot="community-review-target" role="status" className="text-sm text-muted-foreground">
              {m.subject_community_review_target_unavailable({}, options)}
            </p>
          )}
          <div
            data-slot="review-citation"
            data-state={
              recorded?.state === 'available'
                ? 'available'
                : recorded?.state === 'absent' || citation === null
                  ? 'unscored'
                  : 'unavailable'
            }
          >
            {recorded && recorded.state !== 'withheld' ? (
              <CommunityRecordedCitation citation={recorded} locale={locale} licence={thread.licence} />
            ) : citation ? (
              <div className="space-y-2 text-sm">
                <p
                  data-slot="community-recorded-citation"
                  data-question-id={citation.questionId}
                  data-vote-revision={citation.revision}
                  data-units={citation.units}
                >
                  {m.thread_provenance_vote(
                    {
                      units: new Intl.NumberFormat(locale).format(citation.units),
                      questionId: citation.questionId,
                      revision: new Intl.NumberFormat(locale).format(citation.revision),
                    },
                    options,
                  )}
                </p>
                <p role="status" className="text-muted-foreground">
                  {m.search_review_historical_question_unavailable({}, options)}
                </p>
              </div>
            ) : (
              <p role={citation === null ? undefined : 'status'} className="text-sm text-muted-foreground">
                {citation === null
                  ? m.thread_provenance_unscored({}, options)
                  : m.subject_community_citation_unavailable({}, options)}
              </p>
            )}
          </div>
        </>
      ) : null}
      <PublicReplyParent context={thread.parentContext} locale={locale} thread={thread} />
      <ReadOnlyReactionCounts thread={thread} locale={locale} reactionsAsOf={reactionsAsOf} />
      {reader !== null && reactionsAsOf !== null && thread.viewerReaction != null ? (
        <p data-slot="community-viewer-reaction" className="text-sm text-muted-foreground">
          {m.subject_community_your_reaction({ reaction: reactionLabels[thread.viewerReaction](locale) }, options)}
        </p>
      ) : null}
      {reader !== null && thread.viewerReaction === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.subject_community_viewer_reaction_unavailable({}, options)}
        </p>
      ) : null}
    </div>
  );
}
