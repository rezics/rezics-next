import { m } from '../../paraglide/messages.js';
import type { IndependentOutcome } from './contract';
import { independentActionClass } from './recovery';
import { Button } from '@rezics/ui/shadcn/button';

export function IndependentMeasuresResult({
  outcome,
  onRetry,
  onRefresh,
}: {
  outcome: IndependentOutcome | null;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  if (!outcome)
    return onRetry ? (
      <Button type="button" variant="outline" className={independentActionClass} onClick={onRetry}>
        {m.library_progress_measures_retry()}
      </Button>
    ) : null;
  if (outcome.state === 'acknowledged') {
    return (
      <p role="status" className="text-sm">
        {m.library_progress_measures_acknowledged({ revision: outcome.revision })}
      </p>
    );
  }
  if (outcome.state === 'partial') {
    return (
      <div className="space-y-3">
        <p role="status">{m.library_progress_measures_partial()}</p>
        <p className="text-sm">{m.library_progress_measures_acknowledged({ revision: outcome.revision })}</p>
        {onRetry ? (
          <Button type="button" variant="outline" className={independentActionClass} onClick={onRetry}>
            {m.library_progress_measures_retry()}
          </Button>
        ) : null}
      </div>
    );
  }
  if (outcome.state === 'conflict') {
    return (
      <div className="space-y-3">
        <p role="alert">{m.library_progress_conflict()}</p>
        {onRetry ? (
          <Button type="button" variant="outline" className={independentActionClass} onClick={onRetry}>
            {m.library_progress_measures_retry()}
          </Button>
        ) : null}
        {onRefresh ? (
          <Button type="button" variant="outline" className={independentActionClass} onClick={onRefresh}>
            {m.library_progress_measures_refresh()}
          </Button>
        ) : null}
      </div>
    );
  }
  if (outcome.state === 'uncertain') {
    return (
      <div className="space-y-3">
        <p role="alert">{m.library_progress_measures_uncertain()}</p>
        {onRetry ? (
          <Button type="button" variant="outline" className={independentActionClass} onClick={onRetry}>
            {m.library_progress_measures_retry()}
          </Button>
        ) : null}
      </div>
    );
  }
  const message =
    outcome.state === 'unsupported'
      ? m.library_progress_unsupported()
      : outcome.state === 'refused'
        ? m.library_progress_refused()
        : outcome.state === 'invalid'
          ? m.library_progress_invalid()
          : m.library_progress_measures_unavailable();
  return (
    <div className="space-y-3">
      <p role="alert">{message}</p>
      {outcome.state === 'unavailable' && onRetry ? (
        <Button type="button" variant="outline" className={independentActionClass} onClick={onRetry}>
          {m.library_progress_measures_retry()}
        </Button>
      ) : null}
    </div>
  );
}
