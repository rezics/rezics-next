import { m } from '../../paraglide/messages.js';
import type { ChecklistVisitKind } from './contract';

export const checklistActionClass =
  'inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center justify-center whitespace-normal rounded-lg border border-border px-4 py-2 text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';
export const checklistPrimaryActionClass =
  'inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center justify-center whitespace-normal rounded-lg bg-primary px-4 py-2 text-center font-medium text-primary-foreground [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring hover:opacity-90 disabled:opacity-60';

const recoveryKinds = new Set<ChecklistVisitKind>([
  'preparing',
  'empty',
  'denied',
  'unavailable',
  'stale',
  'conflict',
  'ambiguous',
  'retry',
  'retired',
]);

export function checklistStatusMessage(kind: ChecklistVisitKind, seam?: string): string {
  if (kind === 'preparing') return m.library_progress_episodes_preparing();
  if (kind === 'empty') return m.library_progress_episodes_empty();
  if (kind === 'denied') return m.library_progress_episodes_denied();
  if (kind === 'stale') return m.library_progress_episodes_stale();
  if (kind === 'conflict') return m.library_progress_conflict();
  if (kind === 'ambiguous') return m.library_progress_episodes_ambiguous();
  if (kind === 'retry') return m.library_progress_episodes_retry();
  if (kind === 'retired') return m.library_progress_episodes_retired();
  if (kind === 'accepted') return m.library_progress_episodes_accepted();
  if (seam) return m.library_progress_episodes_native_unavailable();
  return m.library_progress_episodes_unavailable();
}

export function EpisodeChecklistRecovery({
  kind,
  seam,
  onRetry,
  onRefresh,
}: {
  kind: ChecklistVisitKind;
  seam?: string;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  if (!recoveryKinds.has(kind) && kind !== 'accepted') return null;
  const live = kind === 'preparing' || kind === 'accepted';
  return (
    <section className="space-y-3" aria-live={live ? 'polite' : undefined}>
      <p role={live ? 'status' : 'alert'} tabIndex={-1} data-checklist-status>
        {checklistStatusMessage(kind, seam)}
      </p>
      {seam && (kind === 'unavailable' || kind === 'retry') ? (
        <p className="text-sm text-muted-foreground">
          {m.library_progress_episodes_native_unavailable()} <code className="break-all">{seam}</code>
        </p>
      ) : null}
      {kind === 'retry' && onRetry ? (
        <button type="button" className={checklistActionClass} onClick={onRetry}>
          {m.library_progress_measures_retry()}
        </button>
      ) : null}
      {kind === 'ambiguous' && onRetry ? (
        <button type="button" className={checklistActionClass} onClick={onRetry}>
          {m.library_progress_measures_retry()}
        </button>
      ) : null}
      {(kind === 'stale' || kind === 'conflict' || kind === 'unavailable' || kind === 'denied') && onRefresh ? (
        <button type="button" className={checklistActionClass} onClick={onRefresh}>
          {kind === 'stale' ? m.library_progress_episodes_restart() : m.library_progress_retry()}
        </button>
      ) : null}
    </section>
  );
}
