import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import { bulkOperationUndoHref } from './bulk-operation-undo';
import { filteredRemovalTransport } from './bulk-filtered-library-removal-server';
import {
  FilteredLibraryRemoval,
  filteredRemovalRequest,
  type FilteredRemovalSource,
} from './bulk-filtered-library-removal';
import type { BulkUndoOutcome } from './bulk-operation-undo-evidence';

type Props = { source: FilteredRemovalSource; boundary: string; eligible: boolean; isCurrent?: () => boolean };
export function FilteredLibraryRemovalControl(props: Props) {
  const address = JSON.stringify([getLocale(), props.source, props.boundary]);
  return <FilteredRemovalLifetime key={address} {...props} address={address} />;
}
function FilteredRemovalLifetime({ source, eligible, address, isCurrent = () => true }: Props & { address: string }) {
  const owner = useCollectionOwnerCurrent(address);
  const router = useRouter({ warn: false });
  const [captureFailed, setCaptureFailed] = useState(false);
  const latest = useRef({ owner, eligible, isCurrent });
  latest.current = { owner, eligible, isCurrent };
  const journey = useRef<FilteredLibraryRemoval | null>(null);
  const [, redraw] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const stop = router?.subscribe('onBeforeNavigate', () => {
      mounted.current = false;
      journey.current?.retire();
      redraw((value) => value + 1);
    });
    return () => {
      mounted.current = false;
      journey.current?.retire();
      stop?.();
    };
  }, [router]);
  const admitted = (kind: 'preview' | 'confirm' | 'read', origin = latest.current) => {
    if (!origin.isCurrent()) return false;
    if (kind === 'read')
      return (
        origin.owner.operationCurrent('library_operation.get') &&
        origin.owner.operationCurrent('library_operation.outcomes')
      );
    return (
      origin.owner.operationCurrent('library_entry.delete', true) &&
      origin.owner.operationCurrent(
        kind === 'preview' ? 'library_operation.preview' : 'library_operation.confirm',
        true,
      )
    );
  };
  const start = () => {
    if (!mounted.current || !latest.current.eligible || !owner.subject || !admitted('preview') || journey.current)
      return;
    try {
      const intent = new FilteredLibraryRemoval(
        filteredRemovalRequest(source),
        owner.subject,
        getLocale(),
        { 'x-csrf-token': owner.csrfToken },
        filteredRemovalTransport,
        {
          context: () => mounted.current && owner.isOwnerCurrent(),
          allowed: (kind) => admitted(kind),
          capture: (kind) => {
            const origin = latest.current;
            return () => admitted(kind, origin);
          },
        },
        () => {
          if (mounted.current) redraw((value) => value + 1);
        },
      );
      journey.current = intent;
      void intent.preview();
    } catch {
      setCaptureFailed(true);
    }
  };
  if (!owner.isCurrent() || !isCurrent()) return null;
  return (
    <div className="space-y-3">
      {captureFailed ? <p role="alert">{m.library_filtered_entry_remove_unavailable()}</p> : null}
      {!journey.current ? (
        <Button variant="outline" disabled={!eligible || !admitted('preview')} onClick={start}>
          {m.library_filtered_entry_remove_action()}
        </Button>
      ) : (
        <FilteredLibraryRemovalReview
          journey={journey.current}
          canWrite={admitted(
            journey.current.state.phase === 'review' || journey.current.state.phase === 'confirmation_uncertain'
              ? 'confirm'
              : 'preview',
          )}
          canRead={admitted('read')}
        />
      )}
    </div>
  );
}

function outcomeLabel(outcome: BulkUndoOutcome) {
  if (outcome.state === 'applied') return m.library_filtered_entry_remove_removed();
  if (outcome.state === 'no_effect' && outcome.reason === 'missing_target')
    return m.library_filtered_entry_remove_missing();
  if (outcome.state === 'conflict') return m.library_filtered_entry_remove_changed();
  if (outcome.state === 'pending' || outcome.state === 'reconciling') return m.library_filtered_entry_remove_pending();
  if (outcome.state === 'denied' || outcome.state === 'cancelled') return m.library_filtered_entry_remove_skipped();
  return m.library_filtered_entry_remove_failed();
}
export function FilteredLibraryRemovalReview({
  journey,
  canWrite,
  canRead,
}: {
  journey: FilteredLibraryRemoval;
  canWrite: boolean;
  canRead: boolean;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { phase, operation, page, reading, readFailure } = journey.state;
  const progress = journey.state.observedOperation ?? operation;
  const retryPreview = ['preview_uncertain', 'preparing', 'unavailable', 'refused'].includes(phase);
  if (phase === 'retired') return null;
  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4 text-sm [overflow-wrap:anywhere]"
      aria-label={m.library_filtered_entry_remove_action()}
      aria-live="polite"
    >
      <p>{m.library_filtered_entry_remove_scope()}</p>
      <p>{m.library_filtered_entry_remove_bounds()}</p>
      {['capturing', 'previewing'].includes(phase) ? (
        <p role="status">{m.library_filtered_entry_remove_previewing()}</p>
      ) : null}
      {retryPreview || phase === 'unsupported' ? (
        <p role="status">
          {phase === 'preparing'
            ? m.library_filtered_entry_remove_preparing()
            : phase === 'unsupported'
              ? m.library_filtered_entry_remove_unsupported()
              : phase === 'preview_uncertain'
                ? m.library_filtered_entry_remove_preview_uncertain()
                : m.library_filtered_entry_remove_unavailable()}
        </p>
      ) : null}
      {retryPreview ? (
        <Button variant="outline" disabled={!canWrite || journey.busy} onClick={() => void journey.preview()}>
          {m.library_filtered_entry_remove_retry_preview()}
        </Button>
      ) : null}
      {operation ? (
        <>
          <p>{m.library_filtered_entry_remove_count({ count: operation.counts.targets })}</p>
          <p>{m.library_filtered_entry_remove_operation({ id: operation.id })}</p>
          <p>{m.library_filtered_entry_remove_phase({ phase: phaseLabel(progress!.phase) })}</p>
          <p>
            {m.library_filtered_entry_remove_progress({
              removed: progress!.counts.applied,
              skipped:
                progress!.counts.no_effect +
                progress!.counts.conflict +
                progress!.counts.denied +
                progress!.counts.cancelled,
              failed: progress!.counts.failed,
              pending: progress!.counts.pending + progress!.counts.reconciling,
            })}
          </p>
          {phase === 'review' ? (
            <>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                {m.library_filtered_entry_remove_acknowledge()}
              </label>
              <Button
                variant="destructive"
                disabled={!canWrite || !acknowledged || journey.busy}
                onClick={() => {
                  if (acknowledged) void journey.confirm();
                }}
              >
                {m.library_filtered_entry_remove_confirm({ count: operation.counts.targets })}
              </Button>
            </>
          ) : null}
          {phase === 'confirming' ? <p role="status">{m.library_filtered_entry_remove_confirming()}</p> : null}
          {phase === 'confirmation_uncertain' ? (
            <>
              <p role="status">{m.library_filtered_entry_remove_confirmation_uncertain()}</p>
              <Button variant="outline" disabled={!canWrite || journey.busy} onClick={() => void journey.confirm(true)}>
                {m.library_filtered_entry_remove_retry_confirmation()}
              </Button>
            </>
          ) : null}
          <Button variant="outline" disabled={!canRead || journey.busy} onClick={() => void journey.read()}>
            {m.library_filtered_entry_remove_read()}
          </Button>
          {reading ? <p role="status">{m.library_filtered_entry_remove_reading()}</p> : null}
          {readFailure ? <p role="status">{m.library_filtered_entry_remove_read_failure()}</p> : null}
          {page ? (
            <>
              {page.outcomes.length === 0 ? <p>{m.library_filtered_entry_remove_empty_page()}</p> : null}
              <ul className="space-y-2">
                {page.outcomes.map((outcome) => (
                  <li key={outcome.ordinal}>
                    <code>{outcome.subjectId}</code>
                    {' · '}
                    {outcomeLabel(outcome)}
                    {outcome.deletion ? (
                      <p>
                        {m.library_filtered_entry_remove_deadline()}{' '}
                        <time dateTime={outcome.deletion.restoreUntil}>{outcome.deletion.restoreUntil}</time>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {page.next ? (
                <Button
                  variant="outline"
                  disabled={!canRead || journey.busy}
                  onClick={() => void journey.read(page.next!)}
                >
                  {m.library_filtered_entry_remove_more()}
                </Button>
              ) : null}
            </>
          ) : null}
          <a
            className="inline-flex min-h-11 items-center underline"
            href={bulkOperationUndoHref(journey.locale, operation.id)}
          >
            {m.library_filtered_entry_remove_restore()}
          </a>
        </>
      ) : null}
    </section>
  );
}

function phaseLabel(phase: string) {
  switch (phase) {
    case 'preview':
      return m.library_bulk_recovery_phase_preview();
    case 'queued':
      return m.library_bulk_recovery_phase_queued();
    case 'discovering':
      return m.library_bulk_recovery_phase_discovering();
    case 'expanding':
      return m.library_bulk_recovery_phase_expanding();
    case 'applying':
      return m.library_bulk_recovery_phase_applying();
    case 'reconciling':
      return m.library_bulk_recovery_phase_reconciling();
    case 'completed':
      return m.library_bulk_recovery_phase_completed();
    case 'completed_with_errors':
      return m.library_bulk_recovery_phase_completed_with_errors();
    case 'cancelled':
      return m.library_bulk_recovery_phase_cancelled();
    case 'stopped':
      return m.library_bulk_recovery_phase_stopped();
    case 'expired':
      return m.library_bulk_recovery_phase_expired();
    default:
      return m.library_filtered_entry_remove_pending();
  }
}
