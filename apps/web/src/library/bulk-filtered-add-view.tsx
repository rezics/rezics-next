import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { CollectionMoveChooser } from './collection-move-chooser';
import type { CollectionDestination } from './collection-read';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import {
  captureFilteredAdd,
  FilteredAddJourney,
  type FilteredAddSource,
  type FilteredAddState,
} from './bulk-filtered-add';
import { filteredAddPort, filteredAddReader } from './bulk-filtered-add-server';
import type { FilteredAddPage } from './bulk-filtered-add-native';

type Props = {
  source: FilteredAddSource;
  address: string;
  disabled?: boolean;
  isCurrent?: () => boolean;
};

/** The route supplies the admitted predicate, never any loaded or accumulated Members rows. */
export function BulkFilteredAdd(props: Props) {
  const owner = useCollectionOwnerCurrent(JSON.stringify([props.address, props.source]));
  if (!owner.subject) return null;
  return <FilteredAddLifetime key={owner.lifetime} {...props} owner={owner} />;
}

function stateMessage(phase: FilteredAddState['phase']) {
  switch (phase) {
    case 'preparing':
      return m.library_filtered_add_preparing();
    case 'preview_uncertain':
      return m.library_filtered_add_preview_uncertain();
    case 'confirmation_uncertain':
      return m.library_filtered_add_confirmation_uncertain();
    case 'unsupported':
      return m.library_filtered_add_unsupported();
    case 'limit':
      return m.library_filtered_add_limit();
    case 'changed':
      return m.library_filtered_add_changed();
    case 'forbidden':
      return m.library_filtered_add_forbidden();
    case 'unavailable':
      return m.library_filtered_add_unavailable();
    case 'previewing':
    case 'confirming':
      return m.library_filtered_add_working();
    default:
      return null;
  }
}
function outcomeLabel(state: FilteredAddPage['outcomes'][number]['state']) {
  switch (state) {
    case 'applied':
      return m.library_filtered_add_added();
    case 'no_effect':
      return m.library_filtered_add_skipped();
    case 'pending':
    case 'reconciling':
      return m.library_filtered_add_pending();
    default:
      return m.library_filtered_add_failed();
  }
}

function reasonLabel(reason: string) {
  switch (reason) {
    case 'collection_full':
      return m.library_filtered_add_full();
    case 'authority_lost':
    case 'target_denied':
      return m.library_filtered_add_authority();
    case 'revision_mismatch':
    case 'incarnation_mismatch':
    case 'missing_target':
      return m.library_filtered_add_stale();
    case 'dependency_unavailable':
      return m.library_filtered_add_dependency();
    default:
      return m.library_filtered_add_failed();
  }
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
      return m.library_filtered_add_working();
  }
}

function FilteredAddLifetime({
  source,
  address,
  disabled = false,
  isCurrent,
  owner,
}: Props & {
  owner: ReturnType<typeof useCollectionOwnerCurrent>;
}) {
  const live = useRef(false);
  const latest = useRef({ owner, disabled, isCurrent });
  latest.current = { owner, disabled, isCurrent };
  const journeyRef = useRef<FilteredAddJourney | null>(null);
  const [journey, setJourney] = useState<FilteredAddJourney | null>(null);
  const [destination, setDestination] = useState<CollectionDestination | null>(null);
  const [issue, setIssue] = useState<'limit' | 'unsupported' | null>(null);
  const [chooserEpoch, setChooserEpoch] = useState(0);
  const [, rerender] = useState(0);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      journeyRef.current?.retire();
    };
  }, []);
  const current = () => live.current && latest.current.owner.isCurrent() && (latest.current.isCurrent?.() ?? true);
  const previewAllowed = () =>
    current() &&
    !latest.current.disabled &&
    latest.current.owner.operationCurrent('library_operation.preview') &&
    !!latest.current.owner.credential();
  const confirmAllowed = () =>
    current() &&
    latest.current.owner.operationCurrent('library_operation.confirm') &&
    !!latest.current.owner.credential();
  const readAllowed = () =>
    current() &&
    latest.current.owner.operationCurrent('library_operation.get') &&
    latest.current.owner.operationCurrent('library_operation.outcomes');
  function review() {
    if (!previewAllowed() || !destination || journeyRef.current) return;
    const captured = captureFilteredAdd(source, destination);
    if (!captured.ok) {
      setIssue(captured.reason);
      return;
    }
    const origin = owner;
    const originCurrent = isCurrent;
    const value = new FilteredAddJourney(
      captured,
      () => live.current && origin.isOwnerCurrent() && (originCurrent?.() ?? true),
      () =>
        journeyRef.current?.state.phase === 'previewed' || journeyRef.current?.state.phase === 'confirmation_uncertain'
          ? confirmAllowed()
          : previewAllowed(),
      {
        ...filteredAddPort,
        read: async (id, cursor) => {
          if (!readAllowed()) return { state: 'forbidden' };
          const readOrigin = latest.current.owner;
          const result = await filteredAddReader(origin.subject!)(id, cursor);
          return readOrigin.isCurrent() ? result : { state: 'unavailable' };
        },
      },
      () => {
        if (live.current) rerender((revision) => revision + 1);
      },
      () => origin.isCurrent(),
    );
    journeyRef.current = value;
    setJourney(value);
    setIssue(null);
    void value.preview(owner.credential()!);
  }
  const state = journey?.state;
  const operation = state?.operation;
  const page = state?.read?.state === 'ready' ? state.read.page : undefined;
  const busy = state?.phase === 'previewing' || state?.phase === 'confirming' || state?.reading;
  const uncertain = state?.phase === 'preview_uncertain' || state?.phase === 'confirmation_uncertain';
  const notice = state ? stateMessage(state.phase) : issue ? stateMessage(issue) : null;
  if (!current()) return null;
  return (
    <section aria-label={m.library_filtered_add_heading()} className="min-w-0 space-y-3 rounded-xl border p-3">
      <h2 className="font-semibold">{m.library_filtered_add_heading()}</h2>
      <p>{m.library_filtered_add_population()}</p>
      <p className="break-all">{m.library_filtered_add_source({ id: source.id })}</p>
      {source.filter === undefined ? null : (
        <details>
          <summary>{m.library_filtered_add_filter()}</summary>
          <pre className="whitespace-pre-wrap break-all">
            {journey?.capture.request.selection.filter ?? JSON.stringify(source.filter)}
          </pre>
        </details>
      )}
      {!journey ? (
        <>
          <CollectionMoveChooser
            key={chooserEpoch}
            sourceId=""
            placement={false}
            current={current}
            disabled={!previewAllowed()}
            onChange={(choice) => {
              if (current()) setDestination(choice?.destination ?? null);
            }}
          />
          <Button type="button" disabled={!destination || !previewAllowed()} onClick={review}>
            {m.library_filtered_add_preview()}
          </Button>
        </>
      ) : (
        <>
          <p className="break-words">
            {m.library_filtered_add_destination({
              title: journey.capture.destination.title,
              id: journey.capture.destination.id,
            })}
          </p>
          {operation ? (
            <>
              <p>{m.library_filtered_add_count({ count: operation.counts.targets })}</p>
              <p>
                {m.library_filtered_add_progress({
                  added: operation.counts.applied,
                  skipped: operation.counts.no_effect,
                  failed:
                    operation.counts.conflict +
                    operation.counts.denied +
                    operation.counts.failed +
                    operation.counts.cancelled,
                  pending: operation.counts.pending + operation.counts.reconciling,
                })}
              </p>
              <p>
                {phaseLabel(operation.phase)} · {m.library_filtered_add_deadline({ deadline: operation.expiresAt })}
              </p>
              {operation.reason ? <p role="status">{reasonLabel(operation.reason)}</p> : null}
              <a className="underline" href={`/${getLocale()}/library/operations/${encodeURIComponent(operation.id)}`}>
                {m.library_filtered_add_recovery()}
              </a>
            </>
          ) : null}
          {state?.phase === 'previewed' ? (
            <Button type="button" disabled={!confirmAllowed() || busy} onClick={() => void journey.confirm()}>
              {m.library_filtered_add_confirm()}
            </Button>
          ) : null}
          {['preparing', 'unavailable', 'preview_uncertain'].includes(state?.phase ?? '') ? (
            <Button
              type="button"
              disabled={!previewAllowed() || busy}
              onClick={() => void journey.preview(owner.credential()!)}
            >
              {m.library_filtered_add_retry()}
            </Button>
          ) : null}
          {state?.phase === 'confirmation_uncertain' ? (
            <Button type="button" disabled={!confirmAllowed() || busy} onClick={() => void journey.confirm()}>
              {m.library_filtered_add_retry_confirmation()}
            </Button>
          ) : null}
          {operation ? (
            <Button
              type="button"
              variant="outline"
              disabled={!readAllowed() || busy}
              onClick={() => void journey.read()}
            >
              {m.library_filtered_add_refresh()}
            </Button>
          ) : null}
          {state?.read && state.read.state !== 'ready' ? (
            <p role="alert">{m.library_filtered_add_unavailable()}</p>
          ) : null}
          {page ? (
            <>
              <ul className="space-y-2">
                {page.outcomes.map((outcome) => (
                  <li key={outcome.ordinal} className="break-all">
                    {outcome.subjectId}: {outcomeLabel(outcome.state)}
                    {outcome.reason ? ` · ${reasonLabel(outcome.reason)}` : ''}
                  </li>
                ))}
              </ul>
              {page.next ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!readAllowed() || busy}
                  onClick={() => void journey.read(page.next!)}
                >
                  {m.library_filtered_add_more()}
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={busy || uncertain || state?.phase === 'confirmed'}
            onClick={() => {
              if (!current() || busy || uncertain) return;
              journey.retire();
              journeyRef.current = null;
              setJourney(null);
              setDestination(null);
              setIssue(null);
              setChooserEpoch((epoch) => epoch + 1);
            }}
          >
            {m.library_filtered_add_new_review()}
          </Button>
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
