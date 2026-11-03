import type { PageAuthors } from '../identity/read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Byline } from './byline';
import type { HistoryContext } from './post-history-context';
import type { HistoryRevisionContext } from './post-history-lifetime';
import { subjectHref } from '../subject/subject-href';
import { threadLocation } from './thread-href';

const link = 'inline-flex min-h-11 items-center underline underline-offset-4 [overflow-wrap:anywhere]';

/** Current presentation is admitted beside history; it never substitutes for a selected revision. */
export function HistoryCurrentContext({
  context,
  authors,
  now,
}: {
  context: HistoryContext;
  authors: PageAuthors;
  now: string;
}) {
  const locale = getLocale();
  const conversation = context.conversation;
  const failed = context.retry.state === 'same_cursor';
  return (
    <aside aria-label={m.post_history_current_context()} className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3">
      <p className="font-medium">{m.post_history_current_context()}</p>
      <nav aria-label={m.board_context_label()} className="flex min-w-0 flex-wrap items-center gap-x-3">
        {context.place.kind === 'global' ? (
          <span>{m.prq_global()}</span>
        ) : (
          <a className={link} href={`/${locale}/realms/${encodeURIComponent(context.place.id)}`}>
            {context.place.id}
          </a>
        )}
        <a className={link} href={`/${locale}/boards/${encodeURIComponent(context.board.id)}`}>
          {context.board.title ?? m.post_history_board()}
        </a>
        <a className={link} href={threadLocation(locale, conversation)}>
          {conversation.title ?? m.thread_history_heading()}
        </a>
      </nav>
      <p>{conversation.kind === 'review' ? m.realm_board_purpose_reviews() : m.realm_board_purpose_discussion()}</p>
      <Byline author={authors?.[conversation.authorId]} createdAt={conversation.createdAt} now={now} />
      {context.authors.state === 'current' && context.authors.items.some((item) => item.state === 'concealed') ? (
        <p>{m.post_history_author_concealed()}</p>
      ) : null}
      {failed ? <p role="status">{m.post_history_context_failed()}</p> : null}
    </aside>
  );
}

/** The exact recorded citation and its delivered question presentation have separate revision identities. */
export function HistoryNativeProvenance({ native, review }: { native: HistoryRevisionContext; review: boolean }) {
  const locale = getLocale();
  const score = native.score;
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  return (
    <aside
      aria-label={m.post_history_recorded_context()}
      className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]"
    >
      {native.subjectState === 'unavailable' ? (
        <p>{m.post_history_targets_failed()}</p>
      ) : native.subjects.length === 0 ? (
        <p>{m.post_history_targets_absent()}</p>
      ) : (
        <ul>
          {native.subjects.map((item) => (
            <li key={item.id} className="space-y-1">
              <p>{m.post_history_original_target({ id: item.id })}</p>
              {item.state === 'available' ? (
                <p>
                  {m.post_history_terminal_target()}{' '}
                  <a
                    className={link}
                    href={subjectHref({ id: item.summary.id, label: item.summary.label?.value ?? '' }, locale).href}
                  >
                    {item.summary.label?.value ?? item.summary.id}
                  </a>{' '}
                  <span dir="ltr">{item.summary.id}</span>
                </p>
              ) : (
                <p>{m.post_history_target_concealed()}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {review ? (
        native.reviewState === 'unavailable' ? (
          <p>{m.post_history_score_failed()}</p>
        ) : score?.state === 'available' ? (
          <dl className="space-y-2">
            <div>
              <dt>{m.thread_provenance_rating()}</dt>
              <dd>{format(score.citation.units)}</dd>
            </div>
            <div>
              <dt>{m.post_history_question()}</dt>
              <dd>{score.question.label}</dd>
            </div>
            <div>
              <dt>{m.post_history_scale()}</dt>
              <dd>
                {m.post_history_scale_value({
                  min: format(score.question.scale.min),
                  max: format(score.question.scale.max),
                  step: format(score.question.scale.displayStep),
                })}
              </dd>
            </div>
            <div>
              <dt>{m.post_history_citation_identity()}</dt>
              <dd dir="ltr">
                {score.citation.questionId} / {format(score.citation.revision)}
              </dd>
            </div>
            <div>
              <dt>{m.post_history_question_presentation()}</dt>
              <dd>{format(score.question.revision)}</dd>
            </div>
            {score.question.lifecycle?.state === 'retired' ? (
              <div>
                <dt>{m.post_history_question_retired()}</dt>
                <dd>{format(score.question.lifecycle.revision)}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p>{m.post_history_score_concealed()}</p>
        )
      ) : null}
    </aside>
  );
}
