import type { Ref } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CollectionTransferReview, CollectionTransferReviewState } from './collection-placement-journey/transfer';

const action =
  'h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-3 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Review is the captured command, including duplicate Subjects with different occurrence IDs. */
export function CollectionTransferReviewPanel({
  transfer,
  transferState,
  pending,
  conflict,
  draftFrozen,
  canWrite,
  canRead,
  headingRef,
  refusal,
  onConfirm,
  onRetryExact,
  onReread,
  onCancel,
}: {
  transfer: CollectionTransferReview;
  transferState: CollectionTransferReviewState;
  pending: boolean;
  conflict: boolean;
  draftFrozen: boolean;
  canWrite: boolean;
  canRead: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  refusal?: string;
  onConfirm: () => void;
  onRetryExact: () => void;
  onReread: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      className="min-w-0 basis-full space-y-5 rounded-xl border border-primary/30 bg-card p-4 [overflow-wrap:anywhere] sm:p-5"
      data-collection-transfer-review
      aria-labelledby="collection-transfer-review-heading"
      aria-busy={pending}
    >
      <div className="space-y-2">
        <h3 id="collection-transfer-review-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
          {m.library_collection_move_review_heading()}
        </h3>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground" id="collection-transfer-atomic">
          {m.library_collection_move_atomic()}
        </p>
      </div>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2" data-transfer-endpoints>
        <div className="min-w-0 space-y-1 rounded-lg border border-border p-3" data-transfer-source>
          <dt className="text-xs font-medium text-muted-foreground">{m.library_collection_move_review_source()}</dt>
          <dd className="min-w-0">
            <a
              href={transfer.sourceHref}
              className="inline-flex min-h-11 items-center font-medium underline underline-offset-4"
            >
              {transfer.sourceTitle}
            </a>
            <p className="text-sm text-muted-foreground">
              {m.library_collection_move_review_revision({ revision: transfer.sourceRevision })}
            </p>
          </dd>
        </div>
        <div className="min-w-0 space-y-1 rounded-lg border border-border p-3" data-transfer-destination>
          <dt className="text-xs font-medium text-muted-foreground">
            {m.library_collection_move_review_destination()}
          </dt>
          <dd className="min-w-0">
            <a
              href={transfer.destinationHref}
              className="inline-flex min-h-11 items-center font-medium underline underline-offset-4"
            >
              {transfer.destination.title}
            </a>
            <p className="text-sm text-muted-foreground">
              {m.library_collection_move_review_revision({ revision: transfer.destination.revision })}
            </p>
          </dd>
        </div>
      </dl>
      <div className="space-y-3">
        <p className="font-medium">
          {m.library_collection_move_review_occurrences({ count: transfer.occurrences.length })}
        </p>
        <ol className="min-w-0 divide-y divide-border rounded-lg border border-border" data-transfer-occurrences>
          {transfer.occurrences.map((occurrence, index) => (
            <li
              key={occurrence.id}
              className="flex min-w-0 items-start gap-3 p-3"
              data-transfer-occurrence={occurrence.id}
            >
              <span aria-hidden="true" className="min-w-6 shrink-0 text-sm tabular-nums text-muted-foreground">
                {new Intl.NumberFormat(getLocale()).format(index + 1)}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{occurrence.title}</p>
                <code className="block break-all text-xs text-muted-foreground">{occurrence.id}</code>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <dl className="space-y-2 rounded-lg bg-muted/40 p-3" data-transfer-placement>
        <dt className="text-sm font-medium">{m.library_collection_move_review_placement()}</dt>
        <dd className="space-y-1 text-sm">
          {transfer.anchor ? (
            <>
              <p>
                {m.library_collection_move_anchor_review({
                  page: transfer.anchor.page,
                  position: transfer.anchor.position,
                  title: transfer.anchor.title,
                })}
              </p>
              <code className="block break-all text-xs text-muted-foreground">{transfer.anchor.id}</code>
            </>
          ) : (
            <p>{m.library_collection_move_first()}</p>
          )}
        </dd>
      </dl>
      {transferState === 'pending' ? <p role="status">{m.library_collection_move_sending()}</p> : null}
      {transferState === 'unknown' ? (
        <div role="alert" className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm leading-relaxed">{m.library_collection_move_unknown()}</p>
          <Button type="button" className={action} disabled={pending || !canWrite} onClick={onRetryExact}>
            {m.library_collection_move_retry_exact()}
          </Button>
        </div>
      ) : null}
      {transferState === 'refused' ? (
        <div role="alert" className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm leading-relaxed">{refusal || m.library_collection_move_refused()}</p>
          <Button type="button" variant="outline" className={action} disabled={pending || !canRead} onClick={onReread}>
            {m.library_collection_move_read_current()}
          </Button>
        </div>
      ) : null}
      {transferState === 'review' ? (
        <div className="flex min-w-0 flex-wrap gap-3 border-t border-border pt-4">
          <Button
            type="button"
            className={`${action} grow sm:grow-0`}
            aria-describedby="collection-transfer-atomic"
            disabled={pending || conflict || !canWrite}
            onClick={onConfirm}
          >
            {m.library_collection_move_confirm()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={action}
            disabled={pending || draftFrozen}
            onClick={onCancel}
          >
            {m.library_collection_move_cancel_review()}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
