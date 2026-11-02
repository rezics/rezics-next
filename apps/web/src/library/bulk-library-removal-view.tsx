import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type {
  BulkLibraryRemovalController,
  BulkLibraryRemovalReview,
} from './bulk-library-removal-controller';
import type { BulkLibraryRemovalTargetOutcome } from './bulk-library-removal';

function outcomeText(outcome: BulkLibraryRemovalTargetOutcome): string {
  if (outcome.state === 'applied') return m.library_bulk_entry_remove_removed();
  if (outcome.state === 'no_effect') return m.library_bulk_entry_remove_already_absent();
  if (outcome.state === 'conflict' && outcome.reason === 'incarnation_mismatch')
    return m.library_bulk_entry_remove_recreated();
  if (outcome.state === 'conflict') return m.library_bulk_entry_remove_changed();
  if (outcome.state === 'denied' || outcome.state === 'cancelled') return m.library_bulk_entry_remove_skipped();
  if (outcome.state === 'pending' || outcome.state === 'reconciling') return m.library_bulk_entry_remove_pending();
  return m.library_bulk_entry_remove_failed();
}

export function BulkLibraryRemovalAction({
  controller,
  pending,
}: {
  controller: BulkLibraryRemovalController;
  pending: boolean;
}) {
  if (!controller.showAction && !controller.changed && !controller.error) return null;
  return (
    <>
      {controller.showAction ? (
        <Button
          variant="outline"
          disabled={!controller.canPreview || pending || controller.busy}
          onClick={() => void controller.preview()}
        >
          {controller.busy && !controller.review
            ? m.library_bulk_entry_remove_previewing()
            : m.library_bulk_entry_remove_action()}
        </Button>
      ) : null}
      {controller.error === 'selection_too_large' ? (
        <p role="alert" className="text-sm">
          {m.library_bulk_entry_remove_selection_too_large()}
        </p>
      ) : null}
      {controller.error === 'preview' ? (
        <p role="alert" className="text-sm">
          {m.library_bulk_entry_remove_preview_error()}
        </p>
      ) : null}
      {controller.changed ? (
        <p role="status" className="text-sm">
          {m.library_bulk_entry_remove_review_required()}
        </p>
      ) : null}
    </>
  );
}

export function BulkLibraryRemovalReviewView({
  controller,
  pending,
}: {
  controller: BulkLibraryRemovalController;
  pending: boolean;
}) {
  const review = controller.review;
  if (!review) return null;
  return <BulkLibraryRemovalReview review={review} controller={controller} pending={pending} />;
}

function BulkLibraryRemovalReview({
  review,
  controller,
  pending,
}: {
  review: BulkLibraryRemovalReview;
  controller: BulkLibraryRemovalController;
  pending: boolean;
}) {
  const titleOf = (subjectId: string) =>
    review.targets.find((target) => target.subjectId === subjectId)?.title ?? subjectId;
  return (
    <section
      aria-label={m.library_bulk_entry_remove_journey()}
      className="space-y-2 rounded-lg border p-3 text-sm"
      data-bulk-library-removal-phase={review.phase}
    >
      {review.operationId ? <p>{m.library_bulk_entry_remove_operation_id({ id: review.operationId })}</p> : null}
      {review.targets.length ? (
        <>
          <p>{m.library_bulk_entry_remove_review_summary({ count: review.targets.length })}</p>
          <p>{m.library_bulk_entry_remove_kept()}</p>
        </>
      ) : null}
      {review.phase === 'previewing' ? (
        <p role="status">{m.library_bulk_entry_remove_previewing()}</p>
      ) : null}
      {review.phase === 'preview-uncertain' ? (
        <>
          <p role="alert">{m.library_bulk_entry_remove_preview_error()}</p>
          <Button
            variant="outline"
            disabled={!controller.canRetryPreview || pending || controller.busy}
            onClick={() => void controller.retryPreview()}
          >
            {m.library_bulk_entry_remove_retry_preview()}
          </Button>
        </>
      ) : null}
      {review.operationId && (review.phase === 'ready' || review.phase === 'uncertain') ? (
        <Button
          disabled={!controller.canConfirm || pending || controller.busy}
          onClick={() => void controller.confirm()}
        >
          {review.phase === 'uncertain'
            ? m.library_bulk_entry_remove_retry_confirmation()
            : m.library_bulk_entry_remove_confirm({ count: review.targets.length })}
        </Button>
      ) : null}
      {review.phase === 'confirming' ? (
        <p role="status">{m.library_bulk_entry_remove_confirming()}</p>
      ) : null}
      {review.phase === 'uncertain' ? (
        <p role="alert">{m.library_bulk_entry_remove_confirmation_uncertain()}</p>
      ) : null}
      {review.phase === 'recovering' ? (
        <p role="status">{m.library_bulk_entry_remove_recovering()}</p>
      ) : null}
      {review.readError ? <p role="alert">{m.library_bulk_entry_remove_read_error()}</p> : null}
      {review.operationId ? (
        <Button
          variant="outline"
          disabled={!controller.canRecover || pending || controller.busy}
          onClick={() => void controller.recover()}
        >
          {m.library_bulk_entry_remove_recover()}
        </Button>
      ) : null}
      {review.outcomes.length ? (
        <div className="space-y-2" aria-label={m.library_bulk_entry_remove_results()}>
          <h3 className="font-medium">{m.library_bulk_entry_remove_results()}</h3>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {review.outcomes.map((outcome) => (
              <li
                key={`${outcome.ordinal}:${outcome.subjectId}`}
                data-bulk-library-removal-outcome={outcome.state}
              >
                {titleOf(outcome.subjectId)}: {outcomeText(outcome)}
              </li>
            ))}
          </ul>
        </div>
      ) : review.phase === 'complete' && !review.readError ? (
        <p>{m.library_bulk_entry_remove_empty()}</p>
      ) : null}
    </section>
  );
}
