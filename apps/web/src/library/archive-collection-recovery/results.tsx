import { localizeHref } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import type { MouseEvent } from 'react';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { EvidenceDetails } from '../archive-progress-recovery/review';
import { actionClass } from '../private-export/controls';
import type { RecoveryOutcomesPage, RecoveryStatus } from './contract';
import type { ReceivingCollectionReadback } from './readback';
import { RecoveryPresentationOutcome } from './presentation';

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
    case 'none':
      return m.library_archive_recovery_effect_not_applicable();
    default:
      return m.library_archive_present_unknown();
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
    case 'none':
      return m.library_archive_recovery_effect_not_applicable();
    default:
      return m.library_archive_present_unknown();
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
    case 'none':
      return m.library_archive_recovery_effect_not_applicable();
    default:
      return m.library_archive_present_unknown();
  }
}

function OutcomeRow({
  item,
  index,
  title,
}: {
  item: RecoveryOutcomesPage['outcomes'][number];
  index: number;
  title?: string;
}) {
  const reason = reasonText(item.outcomeReason);
  return (
    <li className="grid min-w-0 gap-2 rounded-lg border p-4">
      <h3 className="font-semibold">
        {m.library_archive_recovery_occurrence_number({ occurrence: index + 1 })} ·{' '}
        {title || m.library_archive_present_title_unavailable()}
      </h3>
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
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        <span className="font-medium">
          {!item.notePresent
            ? m.library_archive_recovery_note_missing()
            : !item.noteValid
              ? m.library_archive_recovery_note_invalid()
              : item.sourceNoteState === 'cleared'
                ? m.library_archive_recovery_note_cleared()
                : item.sourceNoteState === 'empty'
                  ? m.library_archive_recovery_note_empty()
                  : m.library_archive_recovery_note_value()}
          :{' '}
        </span>
        {item.note}
      </p>
      {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
      <EvidenceDetails value={item} />
    </li>
  );
}

export function ArchiveRecoveryUnknown({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={m.library_archive_present_unknown()}>
      <p role="status">{m.library_archive_recovery_uncertain()}</p>
      <button type="button" className={actionClass} disabled={busy} onClick={onRetry}>
        {m.library_archive_recovery_retry_original()}
      </button>
    </section>
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
  receiving,
  busy,
  canPrevious,
  onRead,
  onFirst,
  onPrevious,
  onNext,
  onReadCollection,
  targets,
  sourceTitle,
}: {
  status: RecoveryStatus;
  targets?: ReadonlyMap<string, EntityPickerSubject>;
  sourceTitle?: string | null;
  page: RecoveryOutcomesPage | null;
  receiving: ReceivingCollectionReadback | null;
  busy: boolean;
  canPrevious: boolean;
  onRead: () => void;
  onFirst: (event: MouseEvent<HTMLButtonElement>) => void;
  onPrevious: (event: MouseEvent<HTMLButtonElement>) => void;
  onNext: (cursor: string, event: MouseEvent<HTMLButtonElement>) => void;
  onReadCollection: (cursor?: string) => void;
}) {
  const collectionId = page?.collection?.id ?? status.collectionId;
  const state = status.state;
  const titles = new Map<string, string>([...(targets?.values() ?? [])].map((target) => [target.id, target.title]));
  const targetTitle = (id: string | null) => (id ? titles.get(id) : undefined);
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
        <h2 id="recovery-results-title" tabIndex={-1} className="text-lg font-semibold">
          {heading}
        </h2>
        {sourceTitle ? <p className="font-medium">{sourceTitle}</p> : null}
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
        <RecoveryPresentationOutcome presentation={status.presentation} />
        {collectionId ? (
          <>
            <a
              className={`${actionClass} inline-flex w-fit items-center underline`}
              href={localizeHref(`/collections/${collectionId}`)}
            >
              {m.library_archive_recovery_open_collection()}
            </a>
            <button className={actionClass} type="button" disabled={busy} onClick={() => onReadCollection()}>
              {m.library_archive_recovery_read_collection()}
            </button>
          </>
        ) : null}
        {receiving ? (
          <section className="grid gap-3 rounded-lg border p-4" data-receiving-collection={receiving.id}>
            <h3 className="font-semibold">{receiving.title}</h3>
            <p className="text-sm [overflow-wrap:anywhere]" data-receiving-presentation>
              <span className="font-medium">{m.library_archive_recovery_presentation_current()}: </span>
              {receiving.presentationKindSource === 'owner'
                ? receiving.presentationKind
                : m.library_collection_mixed_label()}
            </p>
            <p>
              {receiving.visibility === 'private'
                ? m.library_visibility_private()
                : receiving.visibility === 'public'
                  ? m.library_visibility_public()
                  : receiving.visibility === 'unlisted'
                    ? m.library_visibility_unlisted()
                    : m.library_archive_present_unavailable()}
              {' · '}
              {m.library_archive_recovery_collection_members({ count: receiving.memberCount })}
            </p>
            <ol className="grid gap-2">
              {receiving.members.map((member, index) => (
                <li key={member.id} className="rounded-md border p-3 text-sm">
                  <p>
                    {m.library_archive_recovery_occurrence_number({ occurrence: index + 1 })} ·{' '}
                    {targetTitle(member.subjectId) || m.library_archive_present_title_unavailable()}
                  </p>
                  {member.note ? <p>{member.note}</p> : null}
                </li>
              ))}
            </ol>
            <EvidenceDetails value={receiving} title={m.library_archive_entry_current()} />
            {receiving.next ? (
              <button
                className={actionClass}
                type="button"
                disabled={busy}
                onClick={() => onReadCollection(receiving.next ?? undefined)}
              >
                {m.library_archive_recovery_next_results()}
              </button>
            ) : null}
          </section>
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
        {canPrevious ? (
          <button className={actionClass} type="button" disabled={busy} onClick={onPrevious}>
            {m.library_window_previous()}
          </button>
        ) : null}
        {page?.next ? (
          <button className={actionClass} type="button" disabled={busy} onClick={(event) => onNext(page.next!, event)}>
            {m.library_archive_recovery_next_results()}
          </button>
        ) : null}
      </div>
      <EvidenceDetails value={status} />
      {page?.outcomes.length ? (
        <ol className="grid gap-3">
          {page.outcomes.map((item, index) => (
            <OutcomeRow
              key={item.sourceOccurrenceId}
              item={item}
              index={index}
              title={targetTitle(item.targetSubjectId)}
            />
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
