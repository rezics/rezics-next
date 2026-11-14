import { ImportEmpty, ImportTarget } from '../personal-list-import/presentation';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ImportSourceOutcome } from '../rich-private-entry/source-confirm';
import type { BangumiOutcome, BangumiRowMeta, BangumiLabelPanelState } from './contract';
import { BangumiAction } from './controls';
import { BangumiLabelOutcomes } from './labels';
import { bangumiOutcomeLabel } from './meaning';
import { BangumiCurrentFacts, BangumiScoreOutcomeView } from './score';

function Outcome({
  outcome,
  row,
  labels,
  busy,
  onInspect,
}: {
  outcome: BangumiOutcome;
  labels: BangumiLabelPanelState | undefined;
  row: BangumiRowMeta | undefined;
  busy: boolean;
  onInspect: (ordinal: number) => void;
}) {
  const acknowledged = outcome.status === 'applied' || outcome.score?.status === 'applied';
  const inspected = !!row?.entryReadback || !!row?.voteReadback;
  return (
    <li className="rounded-md border p-3" data-bangumi-outcome={outcome.status} data-bangumi-row={outcome.ordinal}>
      <p className="font-medium [overflow-wrap:anywhere]">{row?.title ?? `#${outcome.ordinal + 1}`}</p>
      <ImportTarget target={row?.target} />
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
      {outcome.score ? <BangumiScoreOutcomeView outcome={outcome.score} /> : null}
      {outcome.status === 'stale' ? (
        <p className="text-sm text-muted-foreground">{m.library_bangumi_stale_help()}</p>
      ) : null}
      {acknowledged && row?.target ? (
        <div className="mt-3 space-y-2">
          <BangumiAction type="button" variant="outline" disabled={busy} onClick={() => onInspect(outcome.ordinal)}>
            {inspected ? m.library_bangumi_refresh_current() : m.library_bangumi_inspect_current()}
          </BangumiAction>
          <BangumiCurrentFacts entry={row.entryReadback} vote={row.voteReadback} />
        </div>
      ) : null}
      {labels ? <BangumiLabelOutcomes panel={labels} /> : null}
      <ImportSourceOutcome outcome={row?.sourceAdmission ?? null} />
    </li>
  );
}

export function BangumiResultPage({
  outcomes,
  remaining,
  labelPanels = {},
  uploadId,
  meta,
  busy,
  cancelled,
  canRetry,
  onRetry,
  onReview,
  onRefresh,
  onInspect,
}: {
  outcomes: BangumiOutcome[];
  labelPanels?: Record<string, BangumiLabelPanelState>;
  uploadId?: string | null;
  remaining: number[];
  meta: BangumiRowMeta[];
  busy: boolean;
  cancelled: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onReview: () => void;
  onRefresh: () => void;
  onInspect: (ordinal: number) => void;
}) {
  const rowsByOrdinal = new Map(meta.map((row) => [row.ordinal, row]));
  const locale = getLocale();
  return (
    <section className="space-y-4" data-bangumi-stage="results">
      <h2 className="text-xl font-semibold">{m.library_import_results()}</h2>
      {outcomes.length === 0 && remaining.length === 0 ? <ImportEmpty results /> : null}
      {cancelled ? (
        <p role="status">{m.library_bangumi_stopped()}</p>
      ) : (
        <p role="status">{m.library_bangumi_partial()}</p>
      )}
      <p className="text-sm text-muted-foreground">{m.library_bangumi_erasure_limit()}</p>
      <ul className="space-y-3">
        {outcomes.map((outcome) => (
          <Outcome
            key={outcome.ordinal}
            outcome={outcome}
            row={rowsByOrdinal.get(outcome.ordinal)}
            labels={labelPanels[`${uploadId}:${outcome.ordinal}`]}
            busy={busy}
            onInspect={onInspect}
          />
        ))}
        {remaining.map((ordinal) => (
          <li
            key={`remaining-${ordinal}`}
            className="rounded-md border p-3"
            data-bangumi-outcome="unattempted"
            data-bangumi-row={ordinal}
          >
            <p className="font-medium [overflow-wrap:anywhere]">
              {rowsByOrdinal.get(ordinal)?.title ?? `#${ordinal + 1}`}
            </p>
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
