import { m } from '../../paraglide/messages.js';
import type { IndependentVisitKind } from './contract';

export const independentActionClass =
  'inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center justify-center whitespace-normal rounded-lg border border-border px-4 py-2 text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';
export const independentPrimaryActionClass =
  'inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center justify-center whitespace-normal rounded-lg bg-primary px-4 py-2 text-center font-medium text-primary-foreground [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring hover:opacity-90 disabled:opacity-60';

export function IndependentMeasuresRecovery({
  kind,
  seam,
  onRetry,
}: {
  kind: IndependentVisitKind | 'empty' | 'denied' | 'unavailable' | 'preparing' | 'stale';
  seam?: string;
  onRetry?: () => void;
}) {
  const message =
    kind === 'preparing'
      ? m.library_progress_measures_preparing()
      : kind === 'empty'
        ? m.library_progress_measures_empty()
        : kind === 'denied'
          ? m.library_progress_measures_denied()
          : kind === 'stale'
            ? m.library_progress_measures_stale()
            : m.library_progress_measures_unavailable();
  return (
    <section className="space-y-3" aria-live={kind === 'preparing' ? 'polite' : undefined}>
      <p role={kind === 'preparing' ? 'status' : 'alert'}>{message}</p>
      {seam ? (
        <p className="text-sm text-muted-foreground">
          {m.library_progress_measures_native_unavailable()} <code className="break-all">{seam}</code>
        </p>
      ) : null}
      {onRetry && kind !== 'preparing' && kind !== 'empty' ? (
        <button type="button" className={independentActionClass} onClick={onRetry}>
          {kind === 'stale' ? m.library_progress_measures_refresh() : m.library_progress_retry()}
        </button>
      ) : null}
    </section>
  );
}
