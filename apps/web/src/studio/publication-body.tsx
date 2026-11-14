import { useCallback, useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { PostReadingBody } from '../threads/post-reading-body';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sameExact, type ArticleReviewSnapshot, type PublicationReview } from './contract';
import type { StudioController, StudioState } from './controller';
import { ExactVersionDetails } from './revisions';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';

/** Optional labels supplied for this exact review. IDs remain the command operands. */
export type ArticlePublicationPresentation = Readonly<{
  destinationLabel?: string;
  licenceLabel?: string;
  subjectLabels?: Readonly<Record<string, string>>;
  mediaLabels?: Readonly<Record<string, string>>;
}>;

/** This reader receives the submitted review, never the working editor or its media presentation. */
export function ArticlePublicationBody({ review, isCurrent }: { review: PublicationReview; isCurrent: () => boolean }) {
  const snapshot = review.articleSnapshot;
  if (!snapshot) return null;
  return (
    <PostReadingBody
      document={snapshot.body}
      readerIdentity={review}
      isReaderCurrent={isCurrent}
      wideVisitKey={`studio-review:${review.entries[0]?.document.postId}:${review.entries[0]?.document.revisionId}`}
    />
  );
}

function ArticleDestination({
  snapshot,
  presentation,
}: {
  snapshot: ArticleReviewSnapshot;
  presentation: ArticlePublicationPresentation | undefined;
}) {
  const options = { locale: getLocale() };
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="studio-help">{m.studio_account_review_destination({}, options)}</p>
        <p className="font-medium">
          <bdi>{presentation?.destinationLabel ?? m.studio_article_unnamed_destination({}, options)}</bdi>
        </p>
        <details>
          <summary className={control}>{m.studio_article_destination_id({}, options)}</summary>
          <code>{snapshot.boardId}</code>
        </details>
      </div>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="studio-help">{m.studio_account_review_licence({}, options)}</p>
        <p className="font-medium">
          <bdi>{presentation?.licenceLabel ?? snapshot.licence}</bdi>
        </p>
        {presentation?.licenceLabel !== undefined ? (
          <details>
            <summary className={control}>{m.studio_article_licence_value({}, options)}</summary>
            <code>{snapshot.licence}</code>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function ArticleOperands({
  snapshot,
  presentation,
}: {
  snapshot: ArticleReviewSnapshot;
  presentation: ArticlePublicationPresentation | undefined;
}) {
  const options = { locale: getLocale() };
  return (
    <details className="min-w-0 [overflow-wrap:anywhere]">
      <summary className={control}>{m.studio_article_references({}, options)}</summary>
      <p className="studio-help">{m.studio_article_references_help({}, options)}</p>
      {(
        [
          [m.own_drafts_subjects({}, options), snapshot.subjectIds, presentation?.subjectLabels],
          [m.own_drafts_media({}, options), snapshot.mediaIds, presentation?.mediaLabels],
        ] as const
      ).map(([heading, ids, labels]) => (
        <section key={heading} className="my-3 min-w-0">
          <h5 className="font-medium">{heading}</h5>
          {ids.length ? (
            <ul className="space-y-2">
              {ids.map((id, index) => (
                <li key={`${index}:${id}`}>
                  {labels?.[id] !== undefined ? (
                    <p>
                      <bdi>{labels[id]}</bdi>
                    </p>
                  ) : null}
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>{m.own_drafts_no_references({}, options)}</p>
          )}
        </section>
      ))}
    </details>
  );
}

type ReviewProps = {
  controller: StudioController;
  state: StudioState;
  review: PublicationReview;
  presentation?: ArticlePublicationPresentation | undefined;
};

/** Retire even an equal-byte replacement before its disclosure or consent can paint. */
export function ArticlePublicationReview(props: ReviewProps) {
  const [visit, setVisit] = useState(() => ({ review: props.review, generation: 0 }));
  if (visit.review !== props.review) {
    setVisit({ review: props.review, generation: visit.generation + 1 });
    return null;
  }
  return <ArticlePublicationReviewVisit key={visit.generation} {...props} />;
}

function ArticlePublicationReviewVisit({ controller, state, review, presentation }: ReviewProps) {
  const options = { locale: getLocale() };
  const confirmationId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const isCurrent = useCallback(() => controller.snapshot().review === review, [controller, review]);
  const snapshot = review.articleSnapshot!;
  const sending = state.operation === 'publish';
  const unresolved = controller.hasUnresolvedCommand();
  const blocked = Boolean(state.operation) || unresolved;
  const selected = state.selected;
  const unsaved = selected?.dirty || selected?.snapshotPending || selected?.invalid || selected?.uploading;
  const title = review.entries[0]!.title.trim() || m.own_drafts_no_title({}, options);
  return (
    <section className="studio-release-review min-w-0" aria-label={m.studio_release_review_label({}, options)}>
      <header className="space-y-2 [overflow-wrap:anywhere]">
        <p className="studio-help">{m.studio_article_prepared({}, options)}</p>
        <h3>{m.studio_release_review_heading({}, options)}</h3>
        <h4 className="text-xl font-semibold">
          <bdi>{title}</bdi>
        </h4>
        <p>
          {review.expectedPublicationRevision
            ? m.studio_release_advances({}, options)
            : m.studio_release_first({}, options)}
        </p>
        <p className="studio-help">{m.studio_article_frozen_help({}, options)}</p>
      </header>
      <section
        className="studio-native-review studio-stack min-w-0"
        aria-label={m.studio_release_article_details({}, options)}
      >
        <ArticleDestination snapshot={snapshot} presentation={presentation} />
        <ArticleOperands snapshot={snapshot} presentation={presentation} />
        <div className="min-w-0 space-y-3">
          <h4>{m.studio_account_review_body({}, options)}</h4>
          <ArticlePublicationBody review={review} isCurrent={isCurrent} />
        </div>
      </section>
      {review.notices.map((notice, index) => (
        <p key={index} className="[overflow-wrap:anywhere]">
          {notice}
        </p>
      ))}
      <section className="studio-stack min-w-0 border-t pt-4" aria-label={m.studio_article_decision({}, options)}>
        <h4>{m.studio_article_decision({}, options)}</h4>
        <ArticleDestination snapshot={snapshot} presentation={presentation} />
        <ExactVersionDetails exact={review.entries[0]!.document} />
        {sending ? (
          <p role="status">{m.studio_article_sending({}, options)}</p>
        ) : unresolved ? (
          <div className="studio-stack" role="status">
            <p className="font-medium">{m.studio_article_uncertain({}, options)}</p>
            <p>{m.studio_article_retry_help({}, options)}</p>
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={Boolean(state.operation)}
              onClick={() => void controller.retry()}
            >
              {m.studio_article_retry({}, options)}
            </Button>
          </div>
        ) : (
          <>
            <label className="studio-confirm" htmlFor={confirmationId}>
              <input
                id={confirmationId}
                type="checkbox"
                checked={confirmed}
                disabled={blocked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>{m.studio_account_confirm({}, options)}</span>
            </label>
            {confirmed ? (
              <p role="status" className="studio-help">
                {m.studio_article_consented({}, options)}
              </p>
            ) : null}
          </>
        )}
        <div className="studio-action-row">
          <Button
            type="button"
            className={control}
            disabled={!confirmed || blocked || Boolean(unsaved)}
            onClick={() => {
              if (isCurrent()) void controller.publish();
            }}
          >
            {m.studio_release_publish_article({}, options)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={blocked}
            onClick={() => {
              if (isCurrent()) controller.cancelReview();
            }}
          >
            {m.library_collection_move_cancel_review({}, options)}
          </Button>
        </div>
      </section>
    </section>
  );
}

/** The acknowledged readback stays a result even when the existing editor owner later observes another revision. */
export function ArticlePublicationOutcome({ state }: { state: StudioState }) {
  const options = { locale: getLocale() };
  const published = state.published!;
  const acknowledged = published.readbackSelection!;
  const current = state.selected?.source;
  const later =
    current && current.revision.exact.postId === acknowledged.revision.exact.postId && current !== acknowledged;
  return (
    <section
      className="studio-stack min-w-0 [overflow-wrap:anywhere]"
      aria-label={m.studio_article_acknowledged({}, options)}
    >
      <h3>{m.studio_article_acknowledged({}, options)}</h3>
      <p role="status">{m.studio_release_receipt({ revision: published.revision }, options)}</p>
      <p>{m.studio_article_acknowledged_help({}, options)}</p>
      <ExactVersionDetails exact={acknowledged.revision.exact} />
      {later ? (
        <section className="studio-stack border-t pt-3" aria-label={m.studio_article_current({}, options)}>
          <h4>{m.studio_article_current({}, options)}</h4>
          <p>{m.studio_article_current_help({}, options)}</p>
          <p>
            <bdi>{current.revision.title.trim() || m.own_drafts_no_title({}, options)}</bdi>
          </p>
          <p>
            {current.visibility === 'published'
              ? m.studio_workspace_published_document({}, options)
              : m.studio_workspace_private_draft({}, options)}
          </p>
          <ExactVersionDetails exact={current.revision.exact} />
          {sameExact(current.revision.exact, acknowledged.revision.exact) ? (
            <p>{m.studio_article_current_matches({}, options)}</p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
