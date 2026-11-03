import { useId } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { Exposure } from '../../kernel/exposure';
import { subjectHref } from '../../subject/subject-href';
import type { ChecklistRow, ChecklistVisit } from './contract';
import { checklistActionClass, checklistPrimaryActionClass } from './states';

function rowLabel(row: ChecklistRow, index: number): string {
  if (row.membership === 'unavailable' || row.episodeSubjectId === null) return m.library_progress_episodes_redacted();
  if (row.label) return row.label;
  if (row.ordinal) return row.ordinal;
  return m.library_progress_episodes_ordinal_unavailable({ index: index + 1 });
}

function selected(visit: ChecklistVisit, id: string, completed: boolean): boolean {
  if (completed) return !visit.selection.remove.includes(id);
  return visit.selection.add.includes(id);
}

export function EpisodeChecklistReadout({
  visit,
  work,
  library,
}: {
  visit: ChecklistVisit;
  work?: { id: string; label?: string | null };
}) {
  const locale = getLocale();
  const workLink = work ? subjectHref({ id: work.id, label: work.label ?? '' }, locale) : null;
  return (
    <section className="space-y-3" aria-label={m.library_progress_episodes_heading()}>
      <h3 className="text-lg font-semibold">{m.library_progress_episodes_heading()}</h3>
      <p className="text-sm text-muted-foreground">{m.library_progress_episodes_intro()}</p>
      {visit.binding ? (
        <p className="text-sm">{m.library_progress_measures_shared_revision({ revision: visit.binding.revision })}</p>
      ) : null}
      {visit.completeness === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">{m.library_progress_episodes_completeness_unavailable()}</p>
      ) : (
        <p className="text-sm">{m.library_progress_episodes_completed({ count: visit.completeness })}</p>
      )}
      {visit.membership === 'unavailable' ? (
        <p role="status">{m.library_progress_episodes_membership_unavailable()}</p>
      ) : null}
      <p className="flex flex-wrap gap-3">
        {workLink ? (
          <Link to={workLink.to} params={workLink.params} preload={false} className={checklistActionClass}>
            {m.library_progress_episodes_return_work()}
          </Link>
        ) : null}
        <Link
          to="/library/progress"
          search={visit.binding ? { subjectId: visit.binding.subjectId } : {}}
          preload={false}
          className={checklistActionClass}
        >
          {m.library_progress_episodes_return_library()}
        </Link>
      </p>
    </section>
  );
}

export function EpisodeChecklistEditor({
  visit,
  busy,
  onToggle,
  onReview,
  onClear,
  onContinue,
}: {
  visit: ChecklistVisit;
  busy: boolean;
  onToggle: (id: string, completed: boolean) => void;
  onReview: () => void;
  onClear: () => void;
  onContinue?: () => void;
}) {
  const headingId = useId();
  const dirty = visit.selection.add.length + visit.selection.remove.length > 0;
  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-lg font-semibold">
        {m.library_progress_episodes_heading()}
      </h3>
      {visit.rows.length ? (
        <ul className="space-y-2">
          {visit.rows.map((row, index) => {
            const id = row.episodeSubjectId;
            const disabled =
              busy ||
              row.membership === 'unavailable' ||
              id === null ||
              row.completed === null ||
              (!row.completed && row.membership !== 'member');
            const checked = id !== null && row.completed !== null ? selected(visit, id, row.completed) : false;
            return (
              <li key={id ?? `redacted:${index}`} className="min-w-0 rounded-lg border border-border p-3">
                {disabled || !id || row.completed === null ? (
                  <p className="text-sm [overflow-wrap:anywhere]">
                    {rowLabel(row, index)}
                    {row.membership === 'detached' ? ` · ${m.library_progress_episodes_detached()}` : ''}
                    {row.membership === 'unavailable' ? ` · ${m.library_progress_episodes_redacted()}` : ''}
                    {row.completed === false ? ` · ${m.library_progress_episodes_unmarked()}` : ''}
                  </p>
                ) : (
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm [overflow-wrap:anywhere]">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0"
                      checked={checked}
                      disabled={busy}
                      onChange={() => onToggle(id, row.completed === true)}
                    />
                    <span>
                      {rowLabel(row, index)}
                      {row.membership === 'detached' ? ` · ${m.library_progress_episodes_detached()}` : ''}
                      {row.ordinal === null && row.membership === 'member'
                        ? ` · ${m.library_progress_episodes_ordinal_unavailable({ index: index + 1 })}`
                        : ''}
                    </span>
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>{m.library_progress_episodes_empty()}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Exposure operation="progress_session.record">
          <button type="button" className={checklistPrimaryActionClass} disabled={busy || !dirty} onClick={onReview}>
            {m.library_progress_episodes_apply()}
          </button>
        </Exposure>
        <Exposure operation="progress_session.record">
          <button type="button" className={checklistActionClass} disabled={busy} onClick={onClear}>
            {m.library_progress_episodes_clear()}
          </button>
        </Exposure>
        {visit.retainedNext && onContinue ? (
          <button type="button" className={checklistActionClass} disabled={busy} onClick={onContinue}>
            {m.library_progress_episodes_continue()}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function EpisodeChecklistReview({
  visit,
  busy,
  clear,
  onConfirm,
  onCancel,
}: {
  visit: ChecklistVisit;
  busy: boolean;
  clear: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-4" aria-label={m.library_progress_episodes_review()}>
      <h3 className="text-lg font-semibold">{m.library_progress_episodes_review()}</h3>
      {visit.binding ? (
        <p className="text-sm">{m.library_progress_measures_shared_revision({ revision: visit.binding.revision })}</p>
      ) : null}
      {clear ? (
        <p>{m.library_progress_episodes_confirm_clear()}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {visit.selection.add.map((id) => (
            <li key={`add:${id}`} className="break-all">
              {m.library_progress_episodes_mark()}: {id}
            </li>
          ))}
          {visit.selection.remove.map((id) => (
            <li key={`remove:${id}`} className="break-all">
              {m.library_progress_episodes_unmark()}: {id}
            </li>
          ))}
        </ul>
      )}
      {visit.pending ? <p role="status">{m.library_progress_episodes_pending()}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" className={checklistPrimaryActionClass} disabled={busy} onClick={onConfirm}>
          {m.library_progress_confirm_correction()}
        </button>
        <button type="button" className={checklistActionClass} disabled={busy || !!visit.retry} onClick={onCancel}>
          {m.library_progress_cancel()}
        </button>
      </div>
    </section>
  );
}
