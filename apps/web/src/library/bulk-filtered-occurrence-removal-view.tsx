import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { bulkOccurrenceRemoveResultKind } from './bulk-occurrence-remove';
import type { FilteredOccurrenceRemoval, RemovalOutcome } from './bulk-filtered-occurrence-removal';

const label = (outcome: RemovalOutcome) => {
  switch (bulkOccurrenceRemoveResultKind(outcome)) {
    case 'removed':
      return m.library_filtered_occurrence_remove_removed();
    case 'changed':
      return m.library_filtered_occurrence_remove_changed();
    case 'missing':
      return m.library_filtered_occurrence_remove_missing();
    case 'skipped':
      return m.library_filtered_occurrence_remove_skipped();
    case 'failed':
      return m.library_filtered_occurrence_remove_failed();
    case 'pending':
      return m.library_filtered_occurrence_remove_pending();
  }
};

/** Display one native manifest/result page at a time, in its supplied occurrence order. */
export function FilteredOccurrenceRemovalReview({
  journey,
  canPreview,
  canConfirm,
}: {
  journey: FilteredOccurrenceRemoval;
  canPreview: boolean;
  canConfirm: boolean;
}) {
  const { state, source, busy } = journey;
  if (!source || state.phase === 'retired') return null;
  const operation = state.operation;
  const read = state.read;
  const result = read?.state === 'ready' ? read : null;
  const retryPreview = ['preparing', 'unavailable', 'preview_uncertain'].includes(state.phase);
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label={m.library_filtered_occurrence_remove_title()}>
      <h3 className="font-medium">{m.library_filtered_occurrence_remove_title()}</h3>
      <p>{m.library_filtered_occurrence_remove_source({ title: source.title, id: source.id })}</p>
      <p className="text-sm text-muted-foreground">{m.library_filtered_occurrence_remove_scope()}</p>
      {operation ? (
        <>
          <p>{m.library_filtered_occurrence_remove_count({ count: operation.counts.targets })}</p>
          <p className="break-all text-sm">
            {m.library_filtered_occurrence_remove_capture({
              revision: operation.selectionSource!.revision,
              id: operation.id,
            })}
          </p>
          {operation.selectionSource?.filter ? (
            <pre className="whitespace-pre-wrap break-all text-xs">{operation.selectionSource.filter}</pre>
          ) : null}
          {operation.counts.targets === 0 ? <p role="status">{m.library_filtered_occurrence_remove_empty()}</p> : null}
        </>
      ) : null}
      {state.phase === 'previewing' ? <p role="status">{m.library_filtered_occurrence_remove_preparing()}</p> : null}
      {state.phase === 'preparing' ? (
        <p role="status">{m.library_filtered_occurrence_remove_source_preparing()}</p>
      ) : null}
      {state.phase === 'unavailable' ? <p role="status">{m.library_filtered_occurrence_remove_unavailable()}</p> : null}
      {state.phase === 'refused' ? <p role="alert">{m.library_filtered_occurrence_remove_refused()}</p> : null}
      {state.phase === 'preview_uncertain' ? (
        <p role="status">{m.library_filtered_occurrence_remove_preview_uncertain()}</p>
      ) : null}
      {retryPreview ? (
        <Button variant="outline" disabled={busy || !canPreview} onClick={() => void journey.preview(true)}>
          {m.library_filtered_occurrence_remove_retry_preview()}
        </Button>
      ) : null}
      {state.phase === 'previewed' && operation && operation.counts.targets > 0 ? (
        <Button
          variant="destructive"
          disabled={busy || !canConfirm || !(Date.parse(operation.expiresAt) > Date.now())}
          onClick={() =>
            void journey.confirm().then((ok) => {
              if (ok) void journey.read();
            })
          }
        >
          {m.library_filtered_occurrence_remove_confirm()}
        </Button>
      ) : null}
      {state.phase === 'confirming' ? <p role="status">{m.library_filtered_occurrence_remove_confirming()}</p> : null}
      {state.phase === 'confirmation_uncertain' ? (
        <>
          <p role="status">{m.library_filtered_occurrence_remove_confirmation_uncertain()}</p>
          <Button
            variant="outline"
            disabled={busy || !canConfirm}
            onClick={() =>
              void journey.confirm(true).then((ok) => {
                if (ok) void journey.read();
              })
            }
          >
            {m.library_filtered_occurrence_remove_retry_confirmation()}
          </Button>
        </>
      ) : null}
      {operation ? (
        <Button variant="outline" disabled={busy} onClick={() => void journey.read()}>
          {m.library_filtered_occurrence_remove_read()}
        </Button>
      ) : null}
      {state.reading ? <p role="status">{m.library_filtered_occurrence_remove_reading()}</p> : null}
      {read && read.state !== 'ready' ? (
        <p role="status">{m.library_filtered_occurrence_remove_read_failed()}</p>
      ) : null}
      {result ? (
        <>
          <ol className="space-y-2" data-filtered-occurrence-remove-results>
            {result.page.outcomes.map((outcome) => (
              <li key={outcome.ordinal} className="break-all text-sm">
                <code>{outcome.memberId}</code>
                {' · '}
                <code>{outcome.subjectId}</code>
                {' · '}
                {label(outcome)}
                {outcome.state === 'applied' && outcome.memberDeletion ? (
                  <p>
                    {m.library_filtered_occurrence_remove_receipt({
                      id: outcome.memberDeletion.deletionId,
                      revision: outcome.memberDeletion.revision,
                      deadline: outcome.memberDeletion.purgeAfter,
                    })}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          {result.page.next ? (
            <Button variant="outline" disabled={busy} onClick={() => void journey.read(result.page.next!)}>
              {m.library_filtered_occurrence_remove_more()}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
