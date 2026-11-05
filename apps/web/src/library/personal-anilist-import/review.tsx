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
  onRefreshQuestion,
}: {
  snap: AniListJourneySnapshot;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
  onNext: () => void;
  onConfirm: () => void;
  onRefreshQuestion: () => void;
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
      <div
        className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
        data-anilist-standard-question
      >
        <div className="min-w-0 space-y-1">
          {snap.question ? (
            <>
              <p className="font-medium">{snap.question.label}</p>
              <p className="[overflow-wrap:anywhere]">
                {snap.question.meaning ?? m.library_anilist_question_meaning_unavailable()}
              </p>
              <p className="text-sm text-muted-foreground">
                {m.library_anilist_question_scale({
                  min: snap.question.scale.min,
                  max: snap.question.scale.max,
                  step: snap.question.scale.displayStep,
                })}{' '}
                · {m.library_anilist_question_revision({ revision: snap.question.revision })}
              </p>
            </>
          ) : (
            <p role="status">
              {snap.questionPending ? m.library_anilist_question_loading() : m.library_anilist_question_unavailable()}
            </p>
          )}
        </div>
        <AniListAction type="button" variant="outline" disabled={busy} onClick={onRefreshQuestion}>
          {m.library_anilist_question_refresh()}
        </AniListAction>
      </div>
      <ul className="space-y-6">
        {snap.page.map((row) => {
          const meta = snap.meta.find((item) => item.ordinal === row.ordinal);
          return (
            <li key={row.ordinal}>
              <AniListRowReview
                row={row}
                {...(meta ? { meta } : {})}
                scoreFormat={snap.scoreFormat}
                question={snap.question}
                questionPending={snap.questionPending}
                questionNotice={snap.questionNotice}
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
