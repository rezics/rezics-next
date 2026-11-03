import { m } from '../../paraglide/messages.js';
import type { MalPage } from './contract';
import { MalAction } from './controls';
import { MalRowReview, type RowDraft } from './row';

export function MalReviewPage({
  page,
  after,
  busy,
  onSave,
  onNext,
  onConfirm,
}: {
  page: MalPage;
  after: number;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onNext: () => void;
  onConfirm: () => void;
}) {
  const reviewed = page.rows.filter((row) => row.review).length;
  return (
    <section className="space-y-6" data-mal-stage="review">
      <p>
        {m.library_mal_page_status({
          shown: page.rows.length,
          total: page.total,
          after: after + 1,
        })}
      </p>
      {page.canceled ? <p role="status">{m.library_mal_canceled()}</p> : null}
      <ul className="space-y-6">
        {page.rows.map((row) => (
          <li key={`${row.kind}:${row.identifier.value}:${row.index}`}>
            <MalRowReview row={row} busy={busy || page.canceled} onSave={onSave} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        {page.next !== null ? (
          <MalAction type="button" variant="outline" disabled={busy} onClick={onNext}>
            {m.library_mal_next_page()}
          </MalAction>
        ) : null}
        <MalAction type="button" disabled={busy || page.canceled || reviewed === 0} onClick={onConfirm}>
          {m.library_mal_continue_confirm()}
        </MalAction>
      </div>
    </section>
  );
}
