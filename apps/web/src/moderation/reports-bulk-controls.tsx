import { useEffect, useId, useRef } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { BulkItemState, BulkSnapshot, ReportsBulkAction } from './reports-bulk-action';
import type { ReportQueueAction } from './reports-view-action';

export const reportReviewDepartureMessages = () => ({
  title: m.moderation_review_leave_title(),
  unsaved: m.moderation_review_leave_unsaved(),
  pending: m.moderation_review_leave_pending(),
});

function outcome(state: BulkItemState) {
  switch (state) {
    case 'unattempted':
      return m.moderation_bulk_unattempted();
    case 'pending':
      return m.moderation_bulk_pending();
    case 'dismissed':
      return m.moderation_bulk_dismissed();
    case 'uncertain':
      return m.moderation_bulk_uncertain();
    case 'conflict':
      return m.moderation_bulk_conflict();
    case 'forbidden':
      return m.moderation_bulk_forbidden();
    case 'sign-in':
      return m.moderation_bulk_sign_in();
    case 'unavailable':
      return m.moderation_bulk_unavailable();
    case 'error':
      return m.moderation_bulk_error();
  }
}

export function ReportsBulkControls({
  controller,
  snapshot,
  onAction,
  onRefresh,
}: {
  controller: ReportsBulkAction;
  snapshot: BulkSnapshot;
  onAction: ReportQueueAction;
  onRefresh?: () => Promise<void>;
}) {
  const id = useId();
  const review = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (snapshot.phase === 'review') review.current?.focus();
    if (snapshot.phase === 'complete') results.current?.focus();
  }, [snapshot.phase]);
  return (
    <ContentItemFrame
      as="article"
      aria-labelledby={`${id}-title`}
      className="min-w-0 max-w-full space-y-4 p-4 text-start leading-relaxed [overflow-wrap:anywhere] sm:p-6"
    >
      <ContentItemHeading id={`${id}-title`} level={2} className="text-lg font-semibold">
        {m.moderation_bulk_title()}
      </ContentItemHeading>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm text-muted-foreground">{m.moderation_bulk_bound()}</p>
        {snapshot.phase === 'selecting' ? (
          <>
            <p aria-live="polite" className="text-sm">
              {m.moderation_bulk_selected({ count: snapshot.selected.length })}
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                onClick={controller.selectLoaded}
              >
                {m.moderation_bulk_select_loaded()}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                disabled={!snapshot.selected.length}
                onClick={controller.clear}
              >
                {m.moderation_bulk_clear()}
              </Button>
              <Button
                ref={trigger}
                type="button"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                disabled={!snapshot.selected.length}
                onClick={controller.review}
              >
                {m.moderation_bulk_review()}
              </Button>
            </div>
          </>
        ) : snapshot.phase === 'review' ? (
          <div
            ref={review}
            tabIndex={-1}
            role="group"
            aria-labelledby={`${id}-review`}
            className="flex min-w-0 flex-col gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            <ContentItemHeading id={`${id}-review`} level={3} className="text-base font-medium">
              {m.moderation_bulk_confirmation({ count: snapshot.selected.length })}
            </ContentItemHeading>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                onClick={() => void controller.confirm(onAction, onRefresh)}
              >
                {m.moderation_bulk_confirm({ count: snapshot.selected.length })}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                onClick={() => {
                  controller.cancel();
                  queueMicrotask(() => trigger.current?.focus());
                }}
              >
                {m.moderation_bulk_cancel()}
              </Button>
            </div>
          </div>
        ) : (
          <div
            ref={results}
            tabIndex={-1}
            aria-labelledby={`${id}-results`}
            className="flex min-w-0 flex-col gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            <ContentItemHeading id={`${id}-results`} level={3} role="status" className="text-base font-medium">
              {snapshot.phase === 'running' ? m.moderation_bulk_running() : m.moderation_bulk_results()}
            </ContentItemHeading>
            <ol aria-live="polite" className="flex min-w-0 flex-col gap-3">
              {snapshot.items.map((item) => (
                <li key={item.reportId} className="flex min-w-0 flex-wrap items-start gap-2 text-sm leading-relaxed">
                  <span className="min-w-0 max-w-full whitespace-pre-wrap">
                    {m.moderation_bulk_item({ number: item.position })} {outcome(item.state)}
                  </span>
                  {item.state === 'uncertain' ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                      disabled={snapshot.phase === 'running'}
                      onClick={() => void controller.retry(item.reportId, onAction, onRefresh)}
                    >
                      {m.moderation_bulk_retry()}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
            {snapshot.refreshing ? <p role="status">{m.moderation_bulk_refreshing()}</p> : null}
            {snapshot.stale ? <p role="alert">{m.moderation_bulk_stale()}</p> : null}
            {onRefresh &&
            snapshot.phase === 'complete' &&
            !snapshot.refreshing &&
            !snapshot.items.some((item) => item.state === 'uncertain') ? (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full self-start whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                onClick={() => void controller.refresh(onRefresh)}
              >
                {m.moderation_bulk_refresh()}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </ContentItemFrame>
  );
}

/** A failed replacement read may retain public command receipts, never old evidence or retry intents. */
export function ReportsBulkRefreshFailure({ items }: { items: readonly import('./reports-bulk-action').BulkItem[] }) {
  const id = useId();
  return (
    <ContentItemFrame
      as="article"
      role="alert"
      aria-labelledby={`${id}-title`}
      className="min-w-0 max-w-full space-y-3 p-4 text-start leading-relaxed [overflow-wrap:anywhere] sm:p-6"
    >
      <ContentItemHeading id={`${id}-title`} level={2} className="text-base font-semibold">
        {m.moderation_bulk_stale()}
      </ContentItemHeading>
      <ol className="flex min-w-0 flex-col gap-3 text-sm leading-relaxed">
        {items.map((item) => (
          <li key={item.reportId} className="min-w-0 whitespace-pre-wrap">
            {m.moderation_bulk_item({ number: item.position })} {outcome(item.state)}
          </li>
        ))}
      </ol>
    </ContentItemFrame>
  );
}
