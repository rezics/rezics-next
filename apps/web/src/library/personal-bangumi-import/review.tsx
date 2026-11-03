import { m } from '../../paraglide/messages.js';
import type { BangumiJourneySnapshot } from './controller';
import { BangumiAction } from './controls';
import { BangumiRowReview, type RowDraft } from './row';

export function BangumiReviewPage({
  snap,
  busy,
  onSave,
  onChoose,
  onNext,
  onConfirm,
}: {
  snap: BangumiJourneySnapshot;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
  onNext: () => void;
  onConfirm: () => void;
}) {
  const reviewed = snap.meta.filter((row) => row.reviewToken).length;
  return (
    <section className="space-y-6" data-bangumi-stage="review">
      <p>
        {m.library_bangumi_page_status({
          shown: snap.page.length,
          total: snap.count,
          after: snap.after + 1,
        })}
      </p>
      {snap.cancelled ? <p role="status">{m.library_bangumi_canceled()}</p> : null}
      <ul className="space-y-6">
        {snap.page.map((row) => (
          <li key={row.ordinal}>
            <BangumiRowReview
              row={row}
              meta={snap.meta.find((item) => item.ordinal === row.ordinal)}
              busy={busy || snap.cancelled}
              onSave={onSave}
              onChoose={onChoose}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        {snap.next !== null ? (
          <BangumiAction type="button" variant="outline" disabled={busy} onClick={onNext}>
            {m.library_bangumi_next_page()}
          </BangumiAction>
        ) : null}
        <BangumiAction type="button" disabled={busy || snap.cancelled || reviewed === 0} onClick={onConfirm}>
          {m.library_bangumi_continue_confirm()}
        </BangumiAction>
      </div>
    </section>
  );
}
