import { ImportPageNavigation, useImportPageFocus, type ImportPagePosition } from '../personal-list-import/page-navigation';
import { ImportDetails, ImportEmpty } from '../personal-list-import/presentation';
import { m } from '../../paraglide/messages.js';
import type { MalOwnVoteReadback, MalPage, MalQuestion } from './contract';
import { MalAction } from './controls';
import { malVoteReadKey } from './meaning';
import { MalRowReview, draftFromRow, draftMatchesReview, type RowDraft } from './row';

export function MalReviewPage({
  page,
  drafts,
  question,
  questionLoading,
  questionUnavailable,
  voteReadbacks,
  after,
  position,
  busy,
  onReadQuestion,
  onReadVote,
  onChangeDraft,
  onSave,
  onNext,
  onPrevious,
  onFirst,
  onConfirm,
}: {
  page: MalPage;
  drafts: Record<number, RowDraft>;
  question: MalQuestion | null;
  questionLoading: boolean;
  questionUnavailable: boolean;
  voteReadbacks: Map<string, MalOwnVoteReadback>;
  after: number;
  position: ImportPagePosition;
  busy: boolean;
  onReadQuestion: () => void;
  onReadVote: (row: MalPage['rows'][number], draft: RowDraft) => void;
  onChangeDraft: (draft: RowDraft) => void;
  onSave: (draft: RowDraft) => void;
  onNext: () => void;
  onPrevious: () => void;
  onFirst: () => void;
  onConfirm: () => void;
}) {
  const pageStatus = useImportPageFocus(after);
  const reviewed = page.rows.filter((row) => row.review).length;
  const hasUnsavedReview = page.rows.some((row) => {
    const draft = drafts[row.index];
    return draft ? !draftMatchesReview(row, draft) : false;
  });
  return (
    <section className="space-y-6" data-mal-stage="review">
      <h2 className="text-xl font-semibold">{m.library_import_review()}</h2>
      <p className="text-sm text-muted-foreground">{m.library_import_review_help()}</p>
      <p ref={pageStatus} role="status" tabIndex={-1} className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
        {m.library_mal_page_status({
          shown: page.rows.length,
          total: page.total,
          after: after + 1,
        })}
      </p>
      <ImportDetails title={m.library_mal_native_score_question()}>
        <div className="space-y-2">
          {question ? (
            <p role="status">{m.library_mal_question_loaded({ label: question.label, revision: question.revision })}</p>
          ) : questionUnavailable ? (
            <p role="status">{m.library_mal_question_unavailable()}</p>
          ) : null}
          <MalAction type="button" variant="outline" disabled={busy || questionLoading} onClick={onReadQuestion}>
            {questionLoading ? m.library_mal_reading_question() : m.library_mal_read_question()}
          </MalAction>
        </div>
      </ImportDetails>
      {page.rows.length === 0 ? <ImportEmpty /> : null}
      {page.canceled ? <p role="status">{m.library_mal_canceled()}</p> : null}
      <ul className="space-y-6">
        {page.rows.map((row) => (
          <li key={`${row.kind}:${row.identifier.value}:${row.index}`}>
            <MalRowReview
              row={row}
              draft={drafts[row.index] ?? draftFromRow(row)}
              question={question}
              voteReadback={voteReadbacks.get(
                malVoteReadKey(
                  row.index,
                  drafts[row.index]?.target ?? row.target ?? '',
                  question?.id ?? row.review?.score?.question.id ?? '',
                ),
              )}
              busy={busy || page.canceled}
              onChange={onChangeDraft}
              onSave={onSave}
              onReadCurrent={() => onReadVote(row, drafts[row.index] ?? draftFromRow(row))}
            />
          </li>
        ))}
      </ul>
      <ImportPageNavigation
        position={position}
        hasNext={page.next !== null}
        nextLabel={m.library_mal_next_page()}
        busy={busy || page.canceled}
        onFirst={onFirst}
        onPrevious={onPrevious}
        onNext={onNext}
      />
      <p className="text-sm text-muted-foreground">{m.library_import_page_confirm_local()}</p>
      <div className="flex flex-wrap gap-3">
        <MalAction
          type="button"
          disabled={busy || page.canceled || reviewed === 0 || hasUnsavedReview}
          onClick={onConfirm}
        >
          {m.library_mal_continue_confirm()}
        </MalAction>
      </div>
      {hasUnsavedReview ? <p role="status">{m.library_mal_review_unsaved()}</p> : null}
    </section>
  );
}
