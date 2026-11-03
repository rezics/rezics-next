import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { BangumiOutcome, BangumiRowMeta } from './contract';
import { BangumiAction } from './controls';
import { bangumiOutcomeLabel } from './meaning';

function Outcome({ outcome, titles }: { outcome: BangumiOutcome; titles: Map<number, string> }) {
  return (
    <li className="rounded-md border p-3" data-bangumi-outcome={outcome.status} data-bangumi-row={outcome.ordinal}>
      <p className="font-medium [overflow-wrap:anywhere]">{titles.get(outcome.ordinal) ?? `#${outcome.ordinal + 1}`}</p>
      <p>{bangumiOutcomeLabel(outcome.status)}</p>
      {outcome.applied.length ? (
        <p className="text-sm">{m.library_bangumi_applied_fields({ fields: outcome.applied.join(', ') })}</p>
      ) : null}
      {outcome.retained.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2">{m.library_bangumi_retained_summary()}</summary>
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_bangumi_retained_fields({ fields: outcome.retained.join(', ') })}
          </p>
        </details>
      ) : null}
      {outcome.status === 'stale' ? (
        <p className="text-sm text-muted-foreground">{m.library_bangumi_stale_help()}</p>
      ) : null}
    </li>
  );
}

export function BangumiResultPage({
  outcomes,
  remaining,
  meta,
  busy,
  cancelled,
  canRetry,
  onRetry,
  onReview,
  onRefresh,
}: {
  outcomes: BangumiOutcome[];
  remaining: number[];
  meta: BangumiRowMeta[];
  busy: boolean;
  cancelled: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onReview: () => void;
  onRefresh: () => void;
}) {
  const titles = new Map(meta.map((row) => [row.ordinal, row.title]));
  const locale = getLocale();
  return (
    <section className="space-y-4" data-bangumi-stage="results">
      {cancelled ? (
        <p role="status">{m.library_bangumi_stopped()}</p>
      ) : (
        <p role="status">{m.library_bangumi_partial()}</p>
      )}
      <p className="text-sm text-muted-foreground">{m.library_bangumi_erasure_limit()}</p>
      <ul className="space-y-3">
        {outcomes.map((outcome) => (
          <Outcome key={outcome.ordinal} outcome={outcome} titles={titles} />
        ))}
        {remaining.map((ordinal) => (
          <li
            key={`remaining-${ordinal}`}
            className="rounded-md border p-3"
            data-bangumi-outcome="unattempted"
            data-bangumi-row={ordinal}
          >
            <p className="font-medium [overflow-wrap:anywhere]">{titles.get(ordinal) ?? `#${ordinal + 1}`}</p>
            <p>{m.library_bangumi_result_unattempted()}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <BangumiAction type="button" variant="outline" disabled={busy} onClick={onReview}>
          {m.library_bangumi_return_review()}
        </BangumiAction>
        <BangumiAction type="button" variant="outline" disabled={busy} onClick={onRefresh}>
          {m.library_bangumi_fresh_read()}
        </BangumiAction>
        {canRetry ? (
          <BangumiAction type="button" disabled={busy} onClick={onRetry}>
            {m.library_bangumi_retry_command()}
          </BangumiAction>
        ) : null}
        <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
          {m.library_bangumi_return_library()}
        </a>
      </div>
    </section>
  );
}
