import { m } from '../../paraglide/messages.js';
import type { VndbJourneySnapshot } from './controller';
import { VndbAction } from './controls';
import { VndbRowReview } from './row';
import type { VndbReviewInput } from './contract';

export function VndbReviewPage({
  snap,
  busy,
  onReview,
  onNext,
  onConfirm,
  onSource,
  onHideSource,
}: {
  snap: VndbJourneySnapshot;
  busy: boolean;
  onReview: (body: VndbReviewInput) => void;
  onNext: () => void;
  onConfirm: () => void;
  onSource: () => void;
  onHideSource: () => void;
}) {
  const current = snap.page?.rows ?? [];
  const reviewed = snap.rows.filter((row) => row.decision).length;
  return (
    <section className="min-w-0 space-y-6" data-vndb-stage="review" tabIndex={-1}>
      <p role="status">{m.library_vndb_page_progress({ shown: current.length, loaded: snap.rows.length, total: snap.total, reviewed })}</p>
      {snap.page?.state === 'cancelled' ? <p role="status">{m.library_bangumi_canceled()}</p> : null}
      <div className="flex flex-wrap gap-3">
        <VndbAction type="button" variant="outline" disabled={busy || snap.sourceVisible} onClick={onSource}>
          {m.library_vndb_source_button()}
        </VndbAction>
        {snap.sourceVisible ? <VndbAction type="button" variant="outline" disabled={busy} onClick={onHideSource}>{m.library_vndb_source_hide()}</VndbAction> : null}
      </div>
      {snap.sourceVisible && snap.sourceXML !== null ? (
        <details open className="rounded-md border p-3" data-vndb-source-xml>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_vndb_source_summary()}</summary>
          <p className="text-sm text-muted-foreground">{m.library_vndb_source_private()}</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{snap.sourceXML}</pre>
        </details>
      ) : null}
      <ul className="space-y-6">
        {current.map((row) => (
          <li key={`${snap.uploadId}:${row.ordinal}`}>
            <VndbRowReview row={row} busy={busy || snap.cancelled} onReview={onReview} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        {snap.page?.next !== null && snap.page ? (
          <VndbAction type="button" variant="outline" disabled={busy} onClick={onNext}>{m.library_vndb_next_page()}</VndbAction>
        ) : null}
        <VndbAction type="button" disabled={busy || snap.cancelled || snap.selection.length === 0} onClick={onConfirm}>
          {m.library_vndb_confirm_selection({ count: snap.selection.length })}
        </VndbAction>
      </div>
    </section>
  );
}
