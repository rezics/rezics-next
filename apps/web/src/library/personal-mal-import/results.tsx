import { m } from '../../paraglide/messages.js';
import type { MalApplyPage, MalOutcome } from './contract';
import { MalAction } from './controls';
import { malOutcomeLabel } from './meaning';

function Outcome({ outcome, titles }: { outcome: MalOutcome; titles: Map<number, string> }) {
  return (
    <li className="rounded-md border p-3" data-mal-outcome={outcome.status} data-mal-row={outcome.row}>
      <p className="font-medium [overflow-wrap:anywhere]">{titles.get(outcome.row) ?? `#${outcome.row + 1}`}</p>
      <p>{malOutcomeLabel(outcome.status)}</p>
      {outcome.applied.length ? (
        <p className="text-sm">{m.library_mal_applied_fields({ fields: outcome.applied.join(', ') })}</p>
      ) : null}
      {outcome.retained.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2">{m.library_mal_retained_summary()}</summary>
          <p className="text-sm [overflow-wrap:anywhere]">{outcome.retained.join(', ')}</p>
        </details>
      ) : null}
      {outcome.reason ? <p className="text-sm text-muted-foreground">{outcome.reason}</p> : null}
    </li>
  );
}

export function MalResultPage({
  result,
  titles,
  busy,
  canRetry,
  onRetry,
  onReview,
  onRefresh,
}: {
  result: MalApplyPage;
  titles: Map<number, string>;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onReview: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="space-y-4" data-mal-stage="results">
      {result.stopped ? <p role="status">{m.library_mal_stopped()}</p> : <p role="status">{m.library_mal_partial()}</p>}
      <ul className="space-y-3">
        {result.outcomes.map((outcome) => (
          <Outcome key={outcome.row} outcome={outcome} titles={titles} />
        ))}
        {result.remaining.map((row) => (
          <li
            key={`remaining-${row}`}
            className="rounded-md border p-3"
            data-mal-outcome="unattempted"
            data-mal-row={row}
          >
            <p className="font-medium [overflow-wrap:anywhere]">{titles.get(row) ?? `#${row + 1}`}</p>
            <p>{m.library_mal_result_unattempted()}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <MalAction type="button" variant="outline" disabled={busy} onClick={onReview}>
          {m.library_mal_return_review()}
        </MalAction>
        <MalAction type="button" variant="outline" disabled={busy} onClick={onRefresh}>
          {m.library_mal_fresh_read()}
        </MalAction>
        {canRetry ? (
          <MalAction type="button" disabled={busy} onClick={onRetry}>
            {m.library_mal_retry_command()}
          </MalAction>
        ) : null}
      </div>
    </section>
  );
}
