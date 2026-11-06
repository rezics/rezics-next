import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import type { VoteCitation } from './post-writes';
import { differingReviewVote } from './revision-provenance';
import { subjectTitle, type ThreadSubject } from './subjects';
import type { ThreadPublishedCitation, ThreadReviewContext } from './thread-page-context';

/** Native revision metadata is a reading region; shadcn has no equivalent provenance component. */
export function RevisionProvenance({
  revision,
  subjects,
  currentVote,
  review = false,
  showLicence = true,
  publishedCitation,
  reviewTarget,
}: {
  revision: { licence: string; subjectIds: readonly string[]; voteCitation?: VoteCitation | null };
  subjects: readonly ThreadSubject[];
  /** Only supplied from an author-private read while the author is still signed in. */
  currentVote?: VoteCitation | null;
  review?: boolean;
  /** False when the reader already displays this revision's licence beside its disclosure control. */
  showLicence?: boolean;
  /** The mounted page supplies recorded units separately from unavailable historical question metadata. */
  publishedCitation?: ThreadPublishedCitation;
  reviewTarget?: ThreadReviewContext['target'];
}) {
  const locale = getLocale();
  const citation = publishedCitation
    ? publishedCitation.state === 'available'
      ? {
          questionId: publishedCitation.questionId,
          units: publishedCitation.units,
          revision: publishedCitation.voteRevision,
        }
      : null
    : revision.voteCitation;
  const citationWithheld = publishedCitation?.state === 'withheld';
  const comparison = differingReviewVote(citation, currentVote);
  const formatNumber = (value: number) => new Intl.NumberFormat(locale).format(value);
  const formatVoteCitation = (vote: VoteCitation) =>
    m.thread_provenance_vote({
      units: formatNumber(vote.units),
      questionId: vote.questionId,
      revision: formatNumber(vote.revision),
    });
  const subjectsById = new Map(subjects.map((subject) => [subject.id, subject] as const));
  const unresolvedSubjectIds = revision.subjectIds.filter((id) => {
    const subject = subjectsById.get(id);
    return !subject || !subjectTitle(subject, locale);
  });
  const hasExactSourceDetails = unresolvedSubjectIds.length > 0 || (citation !== null && citation !== undefined);
  return (
    <aside aria-label={m.thread_provenance_heading()} className="min-w-0 space-y-3 text-sm text-muted-foreground">
      {showLicence ? (
        <p className="break-words">
          <span className="font-medium">{m.thread_history_licence()}:</span> {revision.licence}
        </p>
      ) : null}
      {reviewTarget ? (
        <div data-slot="thread-review-target" className="space-y-1">
          <p className="font-medium">{m.subject_community_original_target()}</p>
          {reviewTarget.state === 'available' && reviewTarget.subject.label ? (
            <a
              href={subjectHref({ id: reviewTarget.subject.id, label: reviewTarget.subject.label.value }, locale).href}
              lang={reviewTarget.subject.label.language || undefined}
              className="inline-flex min-h-11 max-w-full items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
            >
              {reviewTarget.subject.label.value}
            </a>
          ) : (
            <p>{m.subject_community_review_target_unavailable()}</p>
          )}
        </div>
      ) : null}
      {revision.subjectIds.length ? (
        <div className="space-y-1">
          <p className="font-medium">{m.thread_provenance_subjects()}</p>
          <ul className="space-y-1">
            {revision.subjectIds.map((id) => {
              const subject = subjectsById.get(id);
              const title = subject ? subjectTitle(subject, locale) : null;
              return (
                <li key={id} className="break-words [overflow-wrap:anywhere]">
                  {title ? (
                    <a href={subjectHref({ id, label: title }, locale).href} className="underline underline-offset-4">
                      {title}
                    </a>
                  ) : (
                    m.discussion_provenance_details_subject_unavailable()
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {citation ? (
        <dl className="space-y-2 [overflow-wrap:anywhere]">
          <div>
            <dt className="font-medium">{m.thread_provenance_rating()}</dt>
            <dd>{m.discussion_provenance_details_rating_units({ units: formatNumber(citation.units) })}</dd>
          </div>
          {comparison ? (
            <div>
              <dt className="font-medium">{m.thread_provenance_current_vote()}</dt>
              <dd>{m.discussion_provenance_details_rating_units({ units: formatNumber(comparison.units) })}</dd>
            </div>
          ) : null}
        </dl>
      ) : citationWithheld ? (
        <p>{m.subject_community_citation_unavailable()}</p>
      ) : review ? (
        <p>{m.thread_provenance_unscored()}</p>
      ) : null}
      {publishedCitation?.state === 'available' ? (
        <p data-slot="thread-historical-question-unavailable">{m.search_review_historical_question_unavailable()}</p>
      ) : null}
      {hasExactSourceDetails ? (
        <details className="min-w-0 [overflow-wrap:anywhere]">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.discussion_provenance_details_heading()}
          </summary>
          <dl className="mt-2 space-y-2 [overflow-wrap:anywhere]">
            {unresolvedSubjectIds.map((id) => (
              <div key={id}>
                <dt className="font-medium">{m.thread_provenance_subjects()}</dt>
                <dd>{m.thread_provenance_subject_reference({ id })}</dd>
              </div>
            ))}
            {citation ? (
              <div>
                <dt className="font-medium">{m.thread_provenance_rating()}</dt>
                <dd>{formatVoteCitation(citation)}</dd>
              </div>
            ) : null}
            {comparison ? (
              <div>
                <dt className="font-medium">{m.discussion_provenance_details_current_vote()}</dt>
                <dd>{formatVoteCitation(comparison)}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </aside>
  );
}
