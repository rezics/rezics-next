import { m } from '../../paraglide/messages.js';
import type { VndbJourneySnapshot } from './controller';
import { VndbAction } from './controls';

function resultLabel(status: string): string {
  if (status === 'applied') return m.library_bangumi_result_applied();
  if (status === 'skipped') return m.library_vndb_result_unchanged();
  if (status === 'stale') return m.library_bangumi_result_stale();
  if (status === 'unsupported') return m.library_bangumi_result_unsupported();
  if (status === 'failed') return m.library_vndb_result_rejected();
  return m.library_vndb_result_uncertain();
}

export function VndbResultPage({
  snap,
  busy,
  onResume,
  onReview,
  onDiscard,
}: {
  snap: VndbJourneySnapshot;
  busy: boolean;
  onResume: () => void;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const title = new Map(snap.rows.map((row) => [row.ordinal, row.title]));
  return (
    <section className="min-w-0 space-y-4" data-vndb-stage="results" tabIndex={-1}>
      <h2 className="text-xl font-semibold">{m.library_vndb_results_title()}</h2>
      <p role="status">
        {m.library_vndb_apply_progress({
          applied: snap.applied,
          total: snap.outcomes.length + snap.unattempted.length,
        })}
      </p>
      {snap.stopped === 'cancelled' ? <p>{m.library_vndb_stopped_cancelled()}</p> : null}
      {snap.stopped === 'deadline' ? <p>{m.library_vndb_stopped_deadline()}</p> : null}
      <p className="text-sm text-muted-foreground">{m.library_vndb_no_rollback()}</p>
      {!snap.reviewCurrent ? <p role="status">{m.library_vndb_review_withdrawn()}</p> : null}
      <ul className="space-y-3">
        {snap.outcomes.map((outcome) => (
          <li
            key={`${outcome.ordinal}:${outcome.reviewId}`}
            className="rounded-md border p-3"
            data-vndb-result={outcome.status}
            data-vndb-row={outcome.ordinal}
          >
            <p className="break-words font-medium">{title.get(outcome.ordinal) ?? `#${outcome.ordinal + 1}`}</p>
            <p>{resultLabel(outcome.status)}</p>
          </li>
        ))}
        {snap.unattempted.map((ordinal) => (
          <li
            key={`unattempted-${ordinal}`}
            className="rounded-md border p-3"
            data-vndb-result={
              snap.retryCommand === 'apply' && snap.pendingOrdinals.includes(ordinal) ? 'pending' : 'unattempted'
            }
            data-vndb-row={ordinal}
          >
            <p className="break-words font-medium">{title.get(ordinal) ?? `#${ordinal + 1}`}</p>
            <p>
              {snap.retryCommand === 'apply' && snap.pendingOrdinals.includes(ordinal)
                ? snap.notice?.kind === 'unknown'
                  ? m.library_vndb_result_uncertain()
                  : m.library_vndb_apply_refused()
                : m.library_bangumi_result_unattempted()}
            </p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        {snap.stopped === 'deadline' ? (
          <VndbAction type="button" disabled={busy} onClick={onResume}>
            {m.library_vndb_resume()}
          </VndbAction>
        ) : null}
        <VndbAction
          type="button"
          variant="outline"
          disabled={busy || !snap.reviewCurrent || !!snap.retryCommand}
          onClick={onReview}
        >
          {m.library_bangumi_return_review()}
        </VndbAction>
        {snap.uploadId ? (
          <VndbAction type="button" variant="outline" disabled={busy || !!snap.retryCommand} onClick={onDiscard}>
            {m.library_bangumi_discard()}
          </VndbAction>
        ) : null}
      </div>
    </section>
  );
}
