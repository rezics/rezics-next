import { useEffect, useRef } from 'react';
import { searchWindowFocus } from '../search/search-window/focus';
import {
  bulkRecoveryStatus,
  canCancelBulkOperation,
  type LibraryBulkRecoveryRead,
  type LibraryBulkOutcome,
} from './bulk-operation-recovery';
import { m } from '../paraglide/messages.js';

type Props = {
  focusOwner?: string;
  addressOperationId: string;
  authorized: boolean;
  read: LibraryBulkRecoveryRead;
  readAgain: (operationId: string) => void;
  readMore: (operationId: string, cursor: string) => void;
  cancel?: () => void;
  retryCancel?: () => void;
  cancelState?: 'idle' | 'capturing' | 'pending' | 'uncertain' | 'refused' | 'accepted';
  cancelAvailable?: boolean;
  busy?: boolean;
  previous?: (() => void) | undefined;
  first?: (() => void) | undefined;
  readRetry?: () => void;
  readFailed?: boolean;
};

function actionLabel(action: string): string {
  switch (action) {
    case 'set_status':
      return m.library_bulk_recovery_action_set_status();
    case 'add_to_collection':
      return m.library_bulk_recovery_action_add_to_collection();
    case 'remove_from_collection':
      return m.library_bulk_recovery_action_remove_from_collection();
    case 'remove_from_library':
      return m.library_bulk_recovery_action_remove_from_library();
    default:
      return action;
  }
}

function phaseLabel(phase: string): string {
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
      return phase;
  }
}

function outcomeLabel(outcome: LibraryBulkOutcome): string {
  switch (bulkRecoveryStatus(outcome)) {
    case 'unattempted':
      return m.library_bulk_recovery_outcome_unattempted();
    case 'running':
      return m.library_bulk_recovery_outcome_running();
    case 'skipped':
      return m.library_bulk_recovery_outcome_skipped();
    case 'failed':
      return m.library_bulk_recovery_outcome_failed();
    case 'success':
      return m.library_bulk_recovery_outcome_success();
  }
}

function unavailableLabel(state: 'expired' | 'forbidden' | 'invalid' | 'unavailable'): string {
  switch (state) {
    case 'expired':
      return m.library_bulk_recovery_expired();
    case 'forbidden':
      return m.library_bulk_recovery_forbidden();
    case 'invalid':
      return m.library_bulk_recovery_invalid();
    case 'unavailable':
      return m.library_bulk_recovery_unavailable();
  }
}

export function LibraryBulkOperationRecoveryView({
  focusOwner = '',
  addressOperationId,
  authorized,
  read,
  readAgain,
  readMore,
  cancel = () => {},
  retryCancel = () => {},
  cancelState = 'idle',
  cancelAvailable = true,
  busy = false,
  previous,
  first,
  readRetry,
  readFailed = false,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef(searchWindowFocus());
  const sequence = useRef(0);
  const focusIdentity = useRef(focusOwner);
  if (focusIdentity.current !== focusOwner || !authorized) {
    focus.current.retire();
    focusIdentity.current = focusOwner;
  }
  useEffect(() => {
    if (!authorized) focus.current.retire();
    else if (!busy && !readFailed && read.state === 'available')
      focus.current.settle(String(sequence.current), null, null, heading.current);
  }, [authorized, busy, readFailed, read]);
  useEffect(() => () => focus.current.retire(), []);
  function activate(event: React.MouseEvent<HTMLButtonElement>, run: () => void) {
    if (event.detail === 0) focus.current.capture(String(++sequence.current), null, 'read', event.currentTarget);
    else focus.current.retire();
    run();
  }
  if (!authorized) return <p role="status">{m.library_bulk_recovery_forbidden()}</p>;
  if (read.state === 'available' && read.operation.id !== addressOperationId)
    return <p role="status">{m.library_bulk_recovery_unavailable()}</p>;
  if (read.state !== 'available' && read.operationId !== addressOperationId)
    return <p role="status">{m.library_bulk_recovery_unavailable()}</p>;
  if (read.state !== 'available')
    return (
      <section aria-live="polite">
        <p role="status">{unavailableLabel(read.state)}</p>
        {read.state === 'unavailable' ? (
          <button
            className="min-h-11 min-w-11"
            type="button"
            disabled={busy}
            onClick={() => (readFailed && readRetry ? readRetry() : readAgain(addressOperationId))}
          >
            {m.library_bulk_recovery_read_again()}
          </button>
        ) : null}
      </section>
    );

  const operation = read.operation;
  return (
    <main>
      <h1 ref={heading} tabIndex={-1}>
        {m.library_bulk_recovery_heading()}
      </h1>
      <dl>
        <dt>{m.library_bulk_recovery_action()}</dt>
        <dd>{actionLabel(operation.action)}</dd>
        <dt>{m.library_bulk_recovery_phase()}</dt>
        <dd>{phaseLabel(operation.phase)}</dd>
        <dt>{m.library_bulk_recovery_target_count()}</dt>
        <dd>{operation.counts.targets}</dd>
        <dt>{m.library_bulk_recovery_progress()}</dt>
        <dd>
          <ul>
            <li>
              {m.library_bulk_recovery_count_unattempted()}: {operation.counts.pending}
            </li>
            <li>
              {m.library_bulk_recovery_count_running()}: {operation.counts.reconciling}
            </li>
            <li>
              {m.library_bulk_recovery_count_skipped()}:{' '}
              {operation.counts.no_effect + operation.counts.conflict + operation.counts.cancelled}
            </li>
            <li>
              {m.library_bulk_recovery_count_failed()}: {operation.counts.denied + operation.counts.failed}
            </li>
            <li>
              {m.library_bulk_recovery_count_success()}: {operation.counts.applied}
            </li>
          </ul>
        </dd>
        <dt>{m.library_bulk_recovery_admitted_at()}</dt>
        <dd>
          <time dateTime={operation.admittedAt}>{operation.admittedAt}</time>
        </dd>
        <dt>{m.library_bulk_recovery_execution_deadline()}</dt>
        <dd>
          <time dateTime={operation.expiresAt}>{operation.expiresAt}</time>
        </dd>
        <dt>{m.library_bulk_recovery_results_deadline()}</dt>
        <dd>
          <time dateTime={operation.resultsExpireAt}>{operation.resultsExpireAt}</time>
        </dd>
      </dl>
      <ol>
        {read.outcomes.map((outcome) => (
          <li key={outcome.ordinal}>
            <span>{outcome.ordinal}</span> <span>{outcome.subjectId}</span> <span>{outcomeLabel(outcome)}</span>
            {outcome.reason ? <span>{outcome.reason}</span> : null}
          </li>
        ))}
      </ol>
      {read.outcomes.length === 0 ? <p>{m.library_bulk_recovery_empty()}</p> : null}
      <nav className="flex flex-wrap gap-2" aria-label={m.library_bulk_recovery_heading()}>
        {previous ? (
          <button className="min-h-11 min-w-11" disabled={busy} onClick={(event) => activate(event, previous)}>
            {m.library_window_previous()}
          </button>
        ) : null}
        {first ? (
          <button className="min-h-11 min-w-11" disabled={busy} onClick={(event) => activate(event, first)}>
            {m.library_window_first()}
          </button>
        ) : null}
        {read.next ? (
          <button
            className="min-h-11 min-w-11"
            disabled={busy}
            onClick={(event) => activate(event, () => readMore(addressOperationId, read.next!))}
          >
            {m.library_bulk_recovery_read_more()}
          </button>
        ) : null}
        <button
          className="min-h-11 min-w-11"
          disabled={busy}
          onClick={(event) => activate(event, () => readAgain(addressOperationId))}
        >
          {m.library_vndb_browse_refresh()}
        </button>
        {readFailed ? (
          <>
            <p role="status">{m.library_bulk_recovery_unavailable()}</p>
            <button
              className="min-h-11 min-w-11"
              disabled={busy}
              onClick={(event) => activate(event, () => readRetry?.())}
            >
              {m.library_bulk_recovery_read_again()}
            </button>
          </>
        ) : null}
      </nav>
      {cancelState === 'uncertain' ? <p role="status">{m.library_bulk_recovery_cancel_uncertain()}</p> : null}
      {cancelState === 'refused' ? <p role="status">{m.library_bulk_recovery_cancel_refused()}</p> : null}
      {cancelState === 'accepted' ? <p role="status">{m.library_bulk_recovery_cancel_accepted()}</p> : null}
      {cancelState === 'uncertain' && cancelAvailable ? (
        <button className="min-h-11 min-w-11" type="button" disabled={busy} onClick={retryCancel}>
          {m.library_bulk_recovery_cancel_retry()}
        </button>
      ) : cancelAvailable &&
        canCancelBulkOperation(operation) &&
        cancelState !== 'refused' &&
        cancelState !== 'accepted' ? (
        <button className="min-h-11 min-w-11" type="button" disabled={busy} onClick={cancel}>
          {cancelState === 'capturing' || cancelState === 'pending'
            ? m.library_bulk_recovery_cancel_pending()
            : m.library_bulk_recovery_cancel()}
        </button>
      ) : null}
    </main>
  );
}
