import { m } from '../../paraglide/messages.js';
import type { AniListJourneySnapshot } from './controller';
import { AniListAction } from './controls';
import { aniListWrapperLabel } from './meaning';
import { AniListRowReview, type RowDraft } from './row';

export function AniListReviewPage({
  snap,
  busy,
  onSave,
  onChoose,
  onNext,
  onConfirm,
}: {
  snap: AniListJourneySnapshot;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
  onNext: () => void;
  onConfirm: () => void;
}) {
  const reviewed = snap.meta.filter((row) => row.reviewId).length;
  return (
    <section className="space-y-6" data-anilist-stage="review">
      <p>
        {m.library_anilist_page_status({
          shown: snap.page.length,
          total: snap.count,
          after: snap.after + 1,
        })}
      </p>
      {snap.completeness ? (
        <p className="text-sm text-muted-foreground">
          {aniListWrapperLabel(snap.completeness)}
          {snap.completeness.hasNextChunk ? ` · ${m.library_anilist_completeness_chunk()}` : ''}
        </p>
      ) : null}
      {snap.completeness?.hasNextChunk ? <p>{m.library_anilist_slice()}</p> : <p>{m.library_anilist_not_complete()}</p>}
      {snap.cancelled ? <p role="status">{m.library_anilist_canceled()}</p> : null}
      <ul className="space-y-6">
        {snap.page.map((row) => {
          const meta = snap.meta.find((item) => item.ordinal === row.ordinal);
          return (
            <li key={row.ordinal}>
              <AniListRowReview
                row={row}
                {...(meta ? { meta } : {})}
                scoreFormat={snap.scoreFormat}
                busy={busy || snap.cancelled}
                onSave={onSave}
                onChoose={onChoose}
              />
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-3">
        {snap.next !== null ? (
          <AniListAction type="button" variant="outline" disabled={busy} onClick={onNext}>
            {m.library_anilist_next_page()}
          </AniListAction>
        ) : null}
        <AniListAction type="button" disabled={busy || snap.cancelled || reviewed === 0} onClick={onConfirm}>
          {m.library_anilist_continue_confirm()}
        </AniListAction>
      </div>
    </section>
  );
}
