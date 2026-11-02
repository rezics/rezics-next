import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import type { VoteCitation } from './post-writes';
import { differingReviewVote } from './revision-provenance';
import { subjectTitle, type ThreadSubject } from './subjects';

/** Native revision metadata is a reading region; shadcn has no equivalent provenance component. */
export function RevisionProvenance({
  revision,
  subjects,
  currentVote,
  review = false,
  showLicence = true,
}: {
  revision: { licence: string; subjectIds: readonly string[]; voteCitation?: VoteCitation | null };
  subjects: readonly ThreadSubject[];
  /** Only supplied from an author-private read while the author is still signed in. */
  currentVote?: VoteCitation | null;
  review?: boolean;
  /** False when the reader already displays this revision's licence beside its disclosure control. */
  showLicence?: boolean;
}) {
  const locale = getLocale();
  const comparison = differingReviewVote(revision.voteCitation, currentVote);
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
  const hasExactSourceDetails =
    unresolvedSubjectIds.length > 0 || (revision.voteCitation !== null && revision.voteCitation !== undefined);
  return (
    <aside aria-label={m.thread_provenance_heading()} className="min-w-0 space-y-3 text-sm text-muted-foreground">
      {showLicence ? (
        <p className="break-words">
          <span className="font-medium">{m.thread_history_licence()}:</span> {revision.licence}
        </p>
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
      {revision.voteCitation ? (
        <dl className="space-y-2 [overflow-wrap:anywhere]">
          <div>
            <dt className="font-medium">{m.thread_provenance_rating()}</dt>
            <dd>
              {m.discussion_provenance_details_rating_units({ units: formatNumber(revision.voteCitation.units) })}
            </dd>
          </div>
          {comparison ? (
            <div>
              <dt className="font-medium">{m.thread_provenance_current_vote()}</dt>
              <dd>{m.discussion_provenance_details_rating_units({ units: formatNumber(comparison.units) })}</dd>
            </div>
          ) : null}
        </dl>
      ) : review ? (
        <p>{m.thread_provenance_unscored()}</p>
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
            {revision.voteCitation ? (
              <div>
                <dt className="font-medium">{m.thread_provenance_rating()}</dt>
                <dd>{formatVoteCitation(revision.voteCitation)}</dd>
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
