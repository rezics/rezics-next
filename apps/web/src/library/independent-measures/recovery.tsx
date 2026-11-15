import { m } from '../../paraglide/messages.js';
import type { IndependentVisitKind } from './contract';
import { Button } from '@rezics/ui/shadcn/button';

export const independentActionClass = 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]';
export const independentPrimaryActionClass = 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]';

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
        <Button type="button" variant="outline" className={independentActionClass} onClick={onRetry}>
          {kind === 'stale' ? m.library_progress_measures_refresh() : m.library_progress_retry()}
        </Button>
      ) : null}
    </section>
  );
}
