import { localizeHref } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { actionClass } from '../private-export/controls';
import type { RecoveryOutcomesPage, RecoveryStatus } from './contract';

function stateText(state: string): string {
  switch (state) {
    case 'applied':
      return m.library_archive_recovery_effect_applied();
    case 'pending':
      return m.library_archive_recovery_effect_pending();
    case 'failed':
      return m.library_archive_recovery_effect_failed();
    case 'unresolved':
      return m.library_archive_recovery_effect_unresolved();
    case 'unsupported':
      return m.library_archive_recovery_effect_unsupported();
    default:
      return m.library_archive_recovery_effect_not_applicable();
  }
}

function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'missing_note':
      return m.library_archive_recovery_reason_missing_note();
    case 'order_unavailable':
      return m.library_archive_recovery_reason_order_unavailable();
    case 'subject_unresolved':
    case 'canonical_mapping_changed':
      return m.library_archive_recovery_reason_subject_unresolved();
    default:
      return m.library_archive_recovery_reason_other();
  }
}

function outcomeText(state: string): string {
  switch (state) {
    case 'applied':
      return m.library_archive_recovery_effect_applied();
    case 'partial':
      return m.library_archive_recovery_partial_title();
    case 'pending':
      return m.library_archive_recovery_effect_pending();
    case 'failed':
      return m.library_archive_recovery_effect_failed();
    case 'unresolved':
      return m.library_archive_recovery_effect_unresolved();
    case 'unsupported':
      return m.library_archive_recovery_effect_unsupported();
    default:
      return m.library_archive_recovery_effect_not_applicable();
  }
}

function pinText(state: string): string {
  switch (state) {
    case 'applied':
      return m.library_archive_recovery_effect_applied();
    case 'pending':
      return m.library_archive_recovery_effect_pending();
    case 'unsupported':
      return m.library_archive_recovery_effect_unsupported();
    default:
      return m.library_archive_recovery_effect_not_applicable();
  }
}

function OutcomeRow({ item }: { item: RecoveryOutcomesPage['outcomes'][number] }) {
  const reason = reasonText(item.outcomeReason);
  return (
    <li className="grid min-w-0 gap-2 rounded-lg border p-4">
      <p className="break-all text-xs text-muted-foreground">
        {m.library_archive_recovery_occurrence_id({ id: item.sourceOccurrenceId })}
      </p>
      <p className="text-sm font-medium">{outcomeText(item.outcome)}</p>
      <dl className="grid gap-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-medium">{m.library_archive_recovery_add_label()}</dt>
          <dd>{stateText(item.addState)}</dd>
        </div>
        <div>
          <dt className="font-medium">{m.library_archive_recovery_note_label()}</dt>
          <dd>{stateText(item.noteState)}</dd>
        </div>
        <div>
          <dt className="font-medium">{m.library_archive_recovery_order_label()}</dt>
          <dd>{stateText(item.orderState)}</dd>
        </div>
      </dl>
      {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
    </li>
  );
}

export function ArchiveRecoveryConflict({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  return (
    <section className="grid gap-4 rounded-xl border p-4" data-recovery-state="conflict">
      <h2 className="text-lg font-semibold">{m.library_archive_recovery_conflict_title()}</h2>
      <p role="status">{m.library_archive_recovery_conflict_help()}</p>
      <button className={actionClass} type="button" disabled={busy} onClick={onRefresh}>
        {m.library_archive_recovery_refresh()}
      </button>
    </section>
  );
}

export function ArchiveRecoveryResults({
  status,
  page,
  busy,
  onRead,
  onFirst,
  onNext,
}: {
  status: RecoveryStatus;
  page: RecoveryOutcomesPage | null;
  busy: boolean;
  onRead: () => void;
  onFirst: () => void;
  onNext: (cursor: string) => void;
}) {
  const collectionId = page?.collection?.id ?? status.collectionId;
  const state = status.state;
  const heading =
    state === 'complete'
      ? m.library_archive_recovery_complete_title()
      : state === 'partial'
        ? m.library_archive_recovery_partial_title()
        : state === 'cancelled'
          ? m.library_archive_recovery_cancelled_title()
          : state === 'expired'
            ? m.library_archive_recovery_expired_title()
            : m.library_archive_recovery_result_title();
  return (
    <section className="grid gap-4" data-recovery-state={state} aria-labelledby="recovery-results-title">
      <div className="grid gap-3 rounded-xl border p-4 sm:p-6">
        <h2 id="recovery-results-title" className="text-lg font-semibold">
          {heading}
        </h2>
        <p role="status">
          {state === 'complete'
            ? m.library_archive_recovery_complete_help()
            : state === 'partial'
              ? m.library_archive_recovery_partial_help()
              : state === 'cancelled'
                ? m.library_archive_recovery_cancelled_help()
                : state === 'expired'
                  ? m.library_archive_recovery_expired_help()
                  : state === 'applying'
                    ? m.library_archive_recovery_applying_help()
                    : m.library_archive_recovery_result_help()}
        </p>
        {collectionId ? (
          <a
            className={`${actionClass} inline-flex w-fit items-center underline`}
            href={localizeHref(`/collections/${collectionId}`)}
          >
            {m.library_archive_recovery_open_collection()}
          </a>
        ) : null}
        <p className="text-sm text-muted-foreground">{m.library_archive_recovery_evidence_independence()}</p>
        {status.pin.state === 'unsupported' ? (
          <p>{m.library_archive_recovery_pin_unsupported()}</p>
        ) : (
          <p>{m.library_archive_recovery_pin_state({ state: pinText(status.pin.state) })}</p>
        )}
      </div>
      {state === 'applying' ? <p role="status">{m.library_archive_recovery_continue_apply_help()}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className={actionClass} type="button" disabled={busy} onClick={onRead}>
          {m.library_archive_recovery_read_outcomes()}
        </button>
        {page ? (
          <button className={actionClass} type="button" disabled={busy} onClick={onFirst}>
            {m.library_archive_recovery_first_page()}
          </button>
        ) : null}
        {page?.next ? (
          <button className={actionClass} type="button" disabled={busy} onClick={() => onNext(page.next!)}>
            {m.library_archive_recovery_next_results()}
          </button>
        ) : null}
      </div>
      {page?.outcomes.length ? (
        <ol className="grid gap-3">
          {page.outcomes.map((item) => (
            <OutcomeRow key={item.sourceOccurrenceId} item={item} />
          ))}
        </ol>
      ) : page ? (
        <p role="status" className="rounded-lg border p-4">
          {m.library_archive_recovery_no_outcomes()}
        </p>
      ) : null}
    </section>
  );
}
