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
  const formatVote = (vote: VoteCitation) =>
    m.thread_provenance_vote({
      units: new Intl.NumberFormat(locale).format(vote.units),
      questionId: vote.questionId,
      revision: new Intl.NumberFormat(locale).format(vote.revision),
    });
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
              const subject = subjects.find((subject) => subject.id === id);
              const title = subject ? subjectTitle(subject, locale) : null;
              return (
                <li key={id} className="break-words [overflow-wrap:anywhere]">
                  {title ? (
                    <a href={subjectHref({ id, label: title }, locale).href} className="underline underline-offset-4">
                      {title}
                    </a>
                  ) : (
                    m.thread_provenance_subject_reference({ id })
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
            <dd>{formatVote(revision.voteCitation)}</dd>
          </div>
          {comparison ? (
            <div>
              <dt className="font-medium">{m.thread_provenance_current_vote()}</dt>
              <dd>{formatVote(comparison)}</dd>
            </div>
          ) : null}
        </dl>
      ) : review ? (
        <p>{m.thread_provenance_unscored()}</p>
      ) : null}
    </aside>
  );
}
