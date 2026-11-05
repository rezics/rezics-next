import type { Ref } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { CollectionTransferReview, CollectionTransferReviewState } from './collection-placement-journey/transfer';

const action =
  'min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

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
      className="basis-full space-y-3 rounded-xl border p-3"
      data-collection-transfer-review
      aria-labelledby="collection-transfer-review-heading"
    >
      <h3
        id="collection-transfer-review-heading"
        ref={headingRef}
        tabIndex={-1}
        className="font-semibold"
      >
        {m.library_collection_move_review_heading()}
      </h3>
      <p>
        <strong>{m.library_collection_move_review_source()}</strong> {transfer.sourceTitle}
      </p>
      <p>{m.library_collection_move_review_occurrences({ count: transfer.occurrences.length })}</p>
      <ul className="min-w-0 space-y-1">
        {transfer.occurrences.map((occurrence) => (
          <li key={occurrence.id} className="min-w-0 break-words [overflow-wrap:anywhere]">
            {occurrence.title} <code className="break-all text-xs">{occurrence.id}</code>
          </li>
        ))}
      </ul>
      <p className="break-words [overflow-wrap:anywhere]">
        <strong>{m.library_collection_move_review_destination()}</strong>{' '}
        <a href={transfer.destinationHref} className="underline underline-offset-4">
          {transfer.destination.title}
        </a>{' '}
        {m.library_collection_move_review_revision({ revision: transfer.destination.revision })}
      </p>
      {transfer.anchor ? (
        <p>
          <strong>{m.library_collection_move_review_placement()}</strong>{' '}
          {m.library_collection_move_anchor_review({
            page: transfer.anchor.page,
            position: transfer.anchor.position,
            title: transfer.anchor.title,
          })}{' '}
          <code className="break-all text-xs">{transfer.anchor.id}</code>
        </p>
      ) : (
        <p>
          <strong>{m.library_collection_move_review_placement()}</strong> {m.library_collection_move_first()}
        </p>
      )}
      <p className="text-sm">{m.library_collection_move_atomic()}</p>
      {transferState === 'pending' ? <p role="status">{m.library_collection_move_sending()}</p> : null}
      {transferState === 'unknown' ? (
        <div role="alert" className="space-y-2">
          <p>{m.library_collection_move_unknown()}</p>
          <Button type="button" variant="outline" className={action} disabled={pending || !canWrite} onClick={onRetryExact}>
            {m.library_collection_move_retry_exact()}
          </Button>
        </div>
      ) : null}
      {transferState === 'refused' ? (
        <div role="alert" className="space-y-2">
          <p>{refusal || m.library_collection_move_refused()}</p>
          <Button type="button" variant="outline" className={action} disabled={pending || !canRead} onClick={onReread}>
            {m.library_collection_move_read_current()}
          </Button>
        </div>
      ) : null}
      {transferState === 'review' ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="button" className={action} disabled={pending || conflict || !canWrite} onClick={onConfirm}>
            {m.library_collection_move_confirm()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={action}
            disabled={pending || draftFrozen || transferState !== 'review'}
            onClick={onCancel}
          >
            {m.library_collection_move_cancel_review()}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
