import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { AniListOutcome, AniListRowMeta } from './contract';
import { AniListAction } from './controls';
import { aniListOutcomeLabel } from './meaning';

function Outcome({ outcome, titles }: { outcome: AniListOutcome; titles: Map<number, string> }) {
  const applied = outcome.status === 'applied' ? ['status'].filter((field) => !outcome.retained.includes(field)) : [];
  return (
    <li className="rounded-md border p-3" data-anilist-outcome={outcome.status} data-anilist-row={outcome.ordinal}>
      <p className="font-medium [overflow-wrap:anywhere]">{titles.get(outcome.ordinal) ?? `#${outcome.ordinal + 1}`}</p>
      <p>{aniListOutcomeLabel(outcome.status)}</p>
      {applied.length ? (
        <p className="text-sm">{m.library_anilist_applied_fields({ fields: applied.join(', ') })}</p>
      ) : (
        <p className="text-sm">{m.library_anilist_applied_summary()}</p>
      )}
      {outcome.retained.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2">{m.library_anilist_retained_summary()}</summary>
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_anilist_retained_fields({ fields: outcome.retained.join(', ') })}
          </p>
        </details>
      ) : null}
      {outcome.status === 'stale' ? (
        <p className="text-sm text-muted-foreground">{m.library_anilist_stale_help()}</p>
      ) : null}
    </li>
  );
}

export function AniListResultPage({
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
  outcomes: AniListOutcome[];
  remaining: number[];
  meta: AniListRowMeta[];
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
    <section className="space-y-4" data-anilist-stage="results">
      {cancelled ? (
        <p role="status">{m.library_anilist_stopped()}</p>
      ) : (
        <p role="status">{m.library_anilist_partial()}</p>
      )}
      <p className="text-sm text-muted-foreground">{m.library_anilist_erasure_limit()}</p>
      <ul className="space-y-3">
        {outcomes.map((outcome) => (
          <Outcome key={outcome.ordinal} outcome={outcome} titles={titles} />
        ))}
        {remaining.map((ordinal) => (
          <li
            key={`remaining-${ordinal}`}
            className="rounded-md border p-3"
            data-anilist-outcome="unattempted"
            data-anilist-row={ordinal}
          >
            <p className="font-medium [overflow-wrap:anywhere]">{titles.get(ordinal) ?? `#${ordinal + 1}`}</p>
            <p>{m.library_anilist_result_unattempted()}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <AniListAction type="button" variant="outline" disabled={busy} onClick={onReview}>
          {m.library_anilist_return_review()}
        </AniListAction>
        <AniListAction type="button" variant="outline" disabled={busy} onClick={onRefresh}>
          {m.library_anilist_fresh_read()}
        </AniListAction>
        {canRetry ? (
          <AniListAction type="button" disabled={busy} onClick={onRetry}>
            {m.library_anilist_retry_command()}
          </AniListAction>
        ) : null}
        <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
          {m.library_anilist_return_library()}
        </a>
      </div>
    </section>
  );
}
