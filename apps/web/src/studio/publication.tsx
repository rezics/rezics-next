import { useEffect, useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { ExactVersionDetails } from './revisions';
import { bookTocRows } from './book-toc';
import type { StudioController, StudioState } from './controller';
import {
  ArticlePublicationOutcome,
  ArticlePublicationReview,
  type ArticlePublicationPresentation,
} from './publication-body';
import type { PublicationReview } from './contract';

export function StudioPublication({
  controller,
  state,
  articlePresentation,
}: {
  controller: StudioController;
  state: StudioState;
  /** Supply only labels already admitted for the exact review; this callback performs no reads. */
  articlePresentation?: (review: PublicationReview) => ArticlePublicationPresentation;
}) {
  const review = state.review;
  const withdrawal = review?.withdrawal;
  const locale = getLocale();
  const options = { locale };
  const plural = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);
  const chapterCount = (count: number) =>
    (plural.select(count) === 'one' ? m.studio_release_chapters_one : m.studio_release_chapters_other)(
      { count: numbers.format(count) },
      options,
    );
  const articleCount = (count: number) =>
    (plural.select(count) === 'one' ? m.studio_release_articles_one : m.studio_release_articles_other)(
      { count: numbers.format(count) },
      options,
    );
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const confirmationId = useId();
  useEffect(() => {
    setConfirmed(false);
    setNow(Date.now());
    if (!review || review.authority === 'local') return;
    const delay = Math.max(0, Date.parse(review.expiresAt) - Date.now());
    // One local expiry timer, without network polling or background work.
    const timer = window.setTimeout(
      () => {
        setNow(Date.now());
        setConfirmed(false);
      },
      Math.min(delay, 2147483647),
    );
    return () => window.clearTimeout(timer);
  }, [review]);
  const expired = review ? review.authority !== 'local' && Date.parse(review.expiresAt) <= now : false;
  const selected = state.selected;
  const unresolved = controller.hasUnresolvedCommand();
  const blocked = Boolean(state.busy) || unresolved;
  const unsaved = selected?.dirty || selected?.snapshotPending || selected?.invalid || selected?.uploading;
  const book = Boolean(state.structure);
  let hasTarget = false;
  try {
    hasTarget = Boolean(controller.publicationTarget());
  } catch {
    /* The organizer presents an invalid structure. */
  }
  if (controller.input.publicationUnavailableReason)
    return (
      <section className="studio-stack" aria-label={m.studio_release_region({}, options)}>
        <h2>{m.own_drafts_publish({}, options)}</h2>
        <p>{controller.input.publicationUnavailableReason}</p>
      </section>
    );
  return (
    <section className="studio-stack" aria-label={m.studio_release_region({}, options)}>
      <div className="studio-section-heading">
        <h2>{m.own_drafts_publish({}, options)}</h2>
        {book ? (
          <span>
            {(plural.select(state.selectedOccurrences.size) === 'one'
              ? m.studio_release_selected_one
              : m.studio_release_selected_other)({ count: numbers.format(state.selectedOccurrences.size) }, options)}
          </span>
        ) : null}
      </div>
      <p className="studio-help">
        {book ? m.studio_release_book_help({}, options) : m.studio_release_article_help({}, options)}
      </p>
      {!controller.input.canPublish ? <p>{m.studio_release_unavailable({}, options)}</p> : null}
      {unsaved ? <p>{m.studio_release_save_first({}, options)}</p> : null}
      {book && !hasTarget ? <p>{m.studio_release_select_chapters({}, options)}</p> : null}
      {review?.authority === 'local' && review.target.kind === 'article' && review.articleSnapshot ? (
        <ArticlePublicationReview
          controller={controller}
          state={state}
          review={review}
          presentation={articlePresentation?.(review)}
        />
      ) : review ? (
        <div
          className="studio-release-review"
          aria-label={withdrawal ? m.studio_withdraw_heading({}, options) : m.studio_release_review_label({}, options)}
        >
          <h3>{withdrawal ? m.studio_withdraw_heading({}, options) : m.studio_release_review_heading({}, options)}</h3>
          {withdrawal ? (
            <div className="studio-stack">
              <p className="studio-break">{m.studio_withdraw_release({ revision: withdrawal.revision }, options)}</p>
              <p>{m.studio_withdraw_discovery({}, options)}</p>
              <p>{m.studio_withdraw_drafts({}, options)}</p>
              <p>{m.studio_withdraw_history({}, options)}</p>
            </div>
          ) : (
            <p>
              {review.expectedPublicationRevision
                ? m.studio_release_advances({}, options)
                : m.studio_release_first({}, options)}
            </p>
          )}
          {review.target.kind === 'book' ? (
            <p className="studio-break">
              {m.studio_release_structure_revision({ revision: review.target.structureRevision }, options)}
            </p>
          ) : null}
          {review.bookOutline && !withdrawal ? (
            <nav aria-label={m.studio_release_frozen_outline({}, options)}>
              <ol className="studio-review-entries">
                {bookTocRows({ ...review.bookOutline, canOrganize: false }).map(({ placement, depth }) => (
                  <li key={placement.occurrenceId} style={{ marginInlineStart: `${Math.min(depth, 8) * 0.75}rem` }}>
                    {placement.target.kind === 'part' ? (
                      <strong>{placement.title}</strong>
                    ) : (
                      <span>{placement.title}</span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          <ol className="studio-review-entries">
            {review.entries.map((entry) => (
              <li key={entry.occurrenceId ?? entry.document.postId}>
                <strong>{entry.title}</strong>
                <ExactVersionDetails exact={entry.document} />
              </li>
            ))}
          </ol>
          {review.notices.map((notice, index) => (
            <p key={index}>{notice}</p>
          ))}
          {review.authority !== 'local' ? (
            <p className="studio-help">
              <time dateTime={review.expiresAt}>
                {m.studio_release_expires({ expiresAt: review.expiresAt }, options)}
              </time>
            </p>
          ) : null}
          {expired ? <p role="status">{m.studio_release_expired({}, options)}</p> : null}
          <label className="studio-confirm" htmlFor={confirmationId}>
            <input
              id={confirmationId}
              type="checkbox"
              checked={confirmed}
              disabled={blocked || expired}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {withdrawal
                ? m.studio_withdraw_confirm({}, options)
                : review.authority === 'local'
                  ? m.studio_account_confirm({}, options)
                  : m.studio_release_confirm({}, options)}
            </span>
          </label>
          <div className="studio-action-row">
            <Button
              type="button"
              variant={withdrawal ? 'destructive' : 'default'}
              disabled={!confirmed || blocked || expired || Boolean(unsaved)}
              onClick={() => void controller.publish()}
            >
              {withdrawal
                ? m.studio_withdraw_action({}, options)
                : book
                  ? m.studio_release_publish_chapters({}, options)
                  : m.studio_release_publish_article({}, options)}
            </Button>
            <Button type="button" variant="outline" disabled={blocked} onClick={controller.cancelReview}>
              {m.library_collection_move_cancel_review({}, options)}
            </Button>
          </div>
        </div>
      ) : null}
      <Button
        type="button"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]"
        variant={review ? 'outline' : 'default'}
        disabled={blocked || !hasTarget || Boolean(unsaved) || !controller.input.canPublish}
        onClick={() => void controller.reviewPublication()}
      >
        {review ? m.studio_release_refresh({}, options) : m.studio_release_review({}, options)}
      </Button>
      {controller.canWithdrawBook() ? (
        <Button
          type="button"
          variant="outline"
          disabled={blocked || Boolean(unsaved)}
          onClick={() => void controller.reviewWithdrawal()}
        >
          {m.studio_withdraw_review({}, options)}
        </Button>
      ) : null}
      {state.published?.readbackSelection ? (
        <ArticlePublicationOutcome state={state} />
      ) : state.published ? (
        <p role="status">
          {state.published.state === 'withdrawn'
            ? m.studio_withdraw_receipt({ revision: state.published.revision }, options)
            : m.studio_release_receipt({ revision: state.published.revision }, options)}
        </p>
      ) : null}
      <details className="studio-publication-history">
        <summary>{m.studio_release_history({}, options)}</summary>
        {state.publications.items.length ? (
          <ol className="studio-history-list">
            {state.publications.items.map((publication) => (
              <li key={`${publication.publicationId}:${publication.revision}`}>
                <h3>
                  {publication.state === 'withdrawn'
                    ? m.studio_release_withdrawn_snapshot({}, options)
                    : m.studio_release_published_snapshot({}, options)}
                </h3>
                <p>
                  {publication.publishedAt ? (
                    <>
                      <time dateTime={publication.publishedAt}>{publication.publishedAt}</time> ·{' '}
                    </>
                  ) : null}
                  {book ? chapterCount(publication.entries.length) : articleCount(publication.entries.length)}
                </p>
                <p className="studio-break">{m.studio_release_revision({ revision: publication.revision }, options)}</p>
                <details>
                  <summary>{m.studio_release_included({}, options)}</summary>
                  <ol>
                    {publication.entries.map((entry) => (
                      <li key={entry.occurrenceId ?? entry.document.postId}>
                        {entry.title}
                        <ExactVersionDetails exact={entry.document} />
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ol>
        ) : (
          <p>{m.studio_release_history_empty({}, options)}</p>
        )}
        {state.publications.nextCursor ? (
          <Button type="button" variant="outline" disabled={blocked} onClick={() => void controller.loadPublications()}>
            {m.studio_release_next({}, options)}
          </Button>
        ) : null}
      </details>
    </section>
  );
}
