import type { MouseEvent } from 'react';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { m } from '../../paraglide/messages.js';
import { EvidenceDetails } from '../archive-progress-recovery/review';
import { actionClass } from '../private-export/controls';
import type { ReceivingCollectionReadback } from './readback';
import { RECEIVING_COLLECTION_PAGE } from './readback';
import type { ReceivingReadWindow } from './receiving-window';

export type ReceivingCollectionActions = {
  onFirst: (event: MouseEvent<HTMLButtonElement>) => void;
  onPrevious: (event: MouseEvent<HTMLButtonElement>) => void;
  onNext: (cursor: string, event: MouseEvent<HTMLButtonElement>) => void;
  onRetry: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function ArchiveReceivingCollection({
  page,
  window,
  busy,
  targets,
  onFirst,
  onPrevious,
  onNext,
  onRetry,
}: ReceivingCollectionActions & {
  page: ReceivingCollectionReadback | null;
  window: ReceivingReadWindow;
  busy: boolean;
  targets?: ReadonlyMap<string, EntityPickerSubject>;
}) {
  const disabled = busy || window.loading;
  const visible = window.failure === 'denied' || window.failure === 'not-found' ? null : page;
  const titles = new Map([...(targets?.values() ?? [])].map((target) => [target.id, target.title]));
  return (
    <section
      className="grid min-w-0 gap-3 rounded-lg border p-4"
      data-receiving-collection={visible?.id ?? ''}
      aria-labelledby="recovery-receiving-title"
      aria-busy={window.loading}
    >
      <h3
        id="recovery-receiving-title"
        tabIndex={-1}
        className="rounded-sm font-semibold [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {visible?.title ?? m.library_archive_recovery_receiving_title()}
      </h3>
      <p className="text-sm text-muted-foreground">
        {m.library_archive_recovery_receiving_scope({ limit: RECEIVING_COLLECTION_PAGE })}
      </p>
      {window.loading ? <p role="status">{m.library_archive_recovery_receiving_loading()}</p> : null}
      {window.failure ? (
        <div className="grid gap-2 rounded-md border p-3" role="status">
          <p>
            {window.failure === 'denied'
              ? m.library_archive_recovery_receiving_denied()
              : window.failure === 'not-found'
                ? m.library_archive_recovery_receiving_missing()
                : window.failure === 'invalid' || window.failure === 'conflict'
                  ? m.library_archive_recovery_receiving_stale()
                  : m.library_archive_recovery_receiving_unavailable()}
          </p>
          {visible ? <p>{m.library_archive_recovery_receiving_previous_displayed()}</p> : null}
        </div>
      ) : null}
      {visible ? (
        <>
          <p className="text-sm [overflow-wrap:anywhere]" data-receiving-presentation>
            <span className="font-medium">{m.library_archive_recovery_presentation_current()}: </span>
            {visible.presentationKindSource === 'owner' ? visible.presentationKind : m.library_collection_mixed_label()}
          </p>
          <p>
            {visible.visibility === 'private'
              ? m.library_visibility_private()
              : visible.visibility === 'public'
                ? m.library_visibility_public()
                : visible.visibility === 'unlisted'
                  ? m.library_visibility_unlisted()
                  : m.library_archive_present_unavailable()}
            {' · '}
            {m.library_archive_recovery_collection_members({ count: visible.memberCount })}
          </p>
          <p className="text-sm">{m.library_archive_recovery_receiving_shown({ count: visible.members.length })}</p>
          {visible.members.length ? (
            <ul className="grid gap-2" aria-label={m.library_archive_recovery_receiving_members()}>
              {visible.members.map((member) => (
                <li key={member.id} className="min-w-0 rounded-md border p-3 text-sm [overflow-wrap:anywhere]">
                  <p className="font-medium">
                    {(member.subjectId ? titles.get(member.subjectId) : null) ||
                      m.library_archive_present_title_unavailable()}
                  </p>
                  {member.note !== null ? <p className="whitespace-pre-wrap">{member.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">
              {visible.next !== null
                ? m.library_archive_recovery_receiving_sparse()
                : m.library_archive_recovery_receiving_empty()}
            </p>
          )}
          <EvidenceDetails value={visible} title={m.library_archive_entry_current()} />
        </>
      ) : null}
      <nav className="flex flex-wrap gap-2" aria-label={m.library_archive_recovery_receiving_navigation()}>
        <button className={`${actionClass} rounded-md border`} type="button" disabled={disabled} onClick={onFirst}>
          {window.displayed || window.requested
            ? m.library_archive_recovery_first_page()
            : m.library_archive_recovery_read_collection()}
        </button>
        {window.previous.length ? (
          <button className={`${actionClass} rounded-md border`} type="button" disabled={disabled} onClick={onPrevious}>
            {m.library_window_previous()}
          </button>
        ) : null}
        {visible && visible.next !== null ? (
          <button
            className={`${actionClass} rounded-md border`}
            type="button"
            disabled={disabled}
            onClick={(event) => onNext(visible.next!, event)}
          >
            {m.library_archive_recovery_receiving_next()}
          </button>
        ) : null}
        {window.failure ? (
          <button className={`${actionClass} rounded-md border`} type="button" disabled={disabled} onClick={onRetry}>
            {m.library_archive_recovery_receiving_retry()}
          </button>
        ) : null}
      </nav>
    </section>
  );
}
