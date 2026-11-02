import { m } from '../paraglide/messages.js';
import { Button } from '@rezics/ui/shadcn/button';
import {
  bulkOccurrenceRemoveResultKind,
  type BulkOccurrenceRemoveCapture,
  type BulkOccurrenceRemoveJourneyState,
} from './bulk-occurrence-remove';
import type { BulkUndoOutcome } from './bulk-operation-undo-evidence';

/** Selection presentation only; the native operation journey owns preview and confirmation controls. */
export function BulkOccurrenceRemoveReview({ capture }: { capture: BulkOccurrenceRemoveCapture }) {
  return (
    <section aria-label={m.library_bulk_occurrence_remove_review()} className="space-y-3 rounded-xl border p-3">
      <h2 className="font-semibold">{m.library_bulk_occurrence_remove_review()}</h2>
      <p>{m.library_bulk_occurrence_remove_source({ title: capture.source.title })}</p>
      <p className="break-all text-sm text-muted-foreground">{capture.source.id}</p>
      <p>{m.library_bulk_occurrence_remove_selection({ count: capture.targets.length })}</p>
      <ol className="space-y-2">
        {capture.targets.map((target) => (
          <li key={target.memberId} className="break-all text-sm">
            {m.library_bulk_occurrence_remove_target({ memberId: target.memberId, subjectId: target.subjectId })}
          </li>
        ))}
      </ol>
    </section>
  );
}

function resultLabel(outcome: BulkUndoOutcome) {
  switch (bulkOccurrenceRemoveResultKind(outcome)) {
    case 'removed':
      return m.library_bulk_occurrence_remove_result_removed();
    case 'changed':
      return m.library_bulk_occurrence_remove_result_changed();
    case 'missing':
      return m.library_bulk_occurrence_remove_result_missing();
    case 'skipped':
      return m.library_bulk_occurrence_remove_result_skipped();
    case 'failed':
      return m.library_bulk_occurrence_remove_result_failed();
    case 'pending':
      return m.library_bulk_occurrence_remove_result_pending();
  }
}

type JourneyProps = {
  state: BulkOccurrenceRemoveJourneyState;
  canWrite: boolean;
  onPreview: () => void;
  onRetryPreview: () => void;
  onConfirm: () => void;
  onRetryConfirm: () => void;
  onRead: () => void;
  onReadMore: (cursor: string) => void;
};

/** The native preview and stored outcomes stay with the Collection selection that created them. */
export function BulkOccurrenceRemoveJourneyControls({
  state,
  canWrite,
  onPreview,
  onRetryPreview,
  onConfirm,
  onRetryConfirm,
  onRead,
  onReadMore,
}: JourneyProps) {
  const busy = state.phase === 'previewing' || state.phase === 'confirming' || state.reading === true;
  const operation = state.read?.state === 'ready' ? state.read.operation : state.operation;
  const outcomes = state.read?.state === 'ready' ? state.read.page.outcomes : [];
  const next = state.read?.state === 'ready' ? state.read.page.next : null;
  const readFailure = state.read && state.read.state !== 'ready';
  return (
    <section className="space-y-3" aria-live="polite" data-bulk-occurrence-remove-operation>
      {state.phase === 'review' ? (
        <Button type="button" variant="outline" disabled={!canWrite || busy} onClick={onPreview}>
          {m.library_bulk_occurrence_remove_preview()}
        </Button>
      ) : null}
      {state.phase === 'previewing' ? <p role="status">{m.library_bulk_occurrence_remove_previewing()}</p> : null}
      {state.phase === 'preview_uncertain' ? (
        <div className="space-y-2">
          <p role="status">{m.library_bulk_occurrence_remove_preview_uncertain()}</p>
          <Button type="button" variant="outline" disabled={!canWrite || busy} onClick={onRetryPreview}>
            {m.library_bulk_occurrence_remove_retry_preview()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'previewed' ? (
        <div className="space-y-2">
          <p role="status">{m.library_bulk_occurrence_remove_preview_ready()}</p>
          <Button type="button" variant="destructive" disabled={!canWrite || busy} onClick={onConfirm}>
            {m.library_bulk_occurrence_remove_confirm()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'confirming' ? <p role="status">{m.library_bulk_occurrence_remove_confirming()}</p> : null}
      {state.phase === 'confirmation_uncertain' ? (
        <div className="space-y-2">
          <p role="status">{m.library_bulk_occurrence_remove_confirmation_uncertain()}</p>
          <Button type="button" variant="outline" disabled={!canWrite || busy} onClick={onRetryConfirm}>
            {m.library_bulk_occurrence_remove_retry_confirmation()}
          </Button>
        </div>
      ) : null}
      {state.reading ? <p role="status">{m.library_bulk_occurrence_remove_reading_results()}</p> : null}
      {readFailure ? (
        <div className="space-y-2">
          <p role="status">{m.library_bulk_occurrence_remove_read_error()}</p>
          <Button type="button" variant="outline" disabled={busy} onClick={onRead}>
            {m.library_bulk_occurrence_remove_read_results()}
          </Button>
        </div>
      ) : null}
      {operation ? (
        <p className="break-all text-sm text-muted-foreground">
          {m.library_bulk_occurrence_remove_operation({ id: operation.id, count: operation.counts.targets })}
        </p>
      ) : null}
      {operation && !state.read && state.phase !== 'previewed' ? (
        <Button type="button" variant="outline" disabled={busy} onClick={onRead}>
          {m.library_bulk_occurrence_remove_read_results()}
        </Button>
      ) : null}
      {state.read?.state === 'ready' ? (
        <>
          <ol className="space-y-2" data-bulk-occurrence-remove-results>
            {outcomes.map((outcome) => (
              <li key={outcome.ordinal} className="break-all text-sm">
                {outcome.memberId ? <code>{outcome.memberId}</code> : <span>#{outcome.ordinal}</span>}
                {' · '}
                <code>{outcome.subjectId}</code>
                {' · '}
                <span>{resultLabel(outcome)}</span>
              </li>
            ))}
          </ol>
          {outcomes.length === 0 ? <p>{m.library_bulk_recovery_empty()}</p> : null}
          {next ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => onReadMore(next)}>
              {m.library_bulk_occurrence_remove_read_more()}
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={busy} onClick={onRead}>
            {m.library_bulk_occurrence_remove_read_results()}
          </Button>
        </>
      ) : null}
    </section>
  );
}
