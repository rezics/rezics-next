import { ImportPageNavigation, useImportPageFocus } from '../personal-list-import/page-navigation';
import type { ReactNode } from 'react';
import type { AniListRow, AniListRowMeta } from './contract';
import { ImportDetails, ImportEmpty } from '../personal-list-import/presentation';
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
  onPrevious,
  onFirst,
  onConfirm,
  onRefreshQuestion,
  renderLabels,
}: {
  snap: AniListJourneySnapshot;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
  onNext: () => void;
  onPrevious: () => void;
  onFirst: () => void;
  onConfirm: () => void;
  onRefreshQuestion: () => void;
  renderLabels?: (row: AniListRow, meta: AniListRowMeta | undefined) => ReactNode;
}) {
  const pageStatus = useImportPageFocus(snap.after);
  const metadata = new Map(snap.meta.map((row) => [row.ordinal, row]));
  const reviewed = snap.meta.filter((row) => row.reviewId).length;
  return (
    <section className="space-y-6" data-anilist-stage="review">
      <h2 className="text-xl font-semibold">{m.library_import_review()}</h2>
      <p className="text-sm text-muted-foreground">{m.library_import_review_help()}</p>
      <p ref={pageStatus} role="status" tabIndex={-1} className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
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
      <ImportDetails title={m.library_import_score()}>
        <div className="flex flex-wrap items-start justify-between gap-3" data-anilist-standard-question>
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
      </ImportDetails>
      {snap.page.length === 0 ? <ImportEmpty /> : null}
      <ul className="space-y-6">
        {snap.page.map((row) => {
          const meta = metadata.get(row.ordinal);
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
              >
                {renderLabels?.(row, meta)}
              </AniListRowReview>
            </li>
          );
        })}
      </ul>
      <ImportPageNavigation
        position={snap.position}
        hasNext={snap.next !== null}
        nextLabel={m.library_anilist_next_page()}
        busy={busy || snap.cancelled}
        onFirst={onFirst}
        onPrevious={onPrevious}
        onNext={onNext}
      />
      <div className="flex flex-wrap gap-3">
        <AniListAction type="button" disabled={busy || snap.cancelled || reviewed === 0} onClick={onConfirm}>
          {m.library_anilist_continue_confirm()}
        </AniListAction>
      </div>
    </section>
  );
}
