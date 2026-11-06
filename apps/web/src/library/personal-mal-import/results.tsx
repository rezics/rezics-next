import { m } from '../../paraglide/messages.js';
import type { SourceAdmissionOutcome } from '../rich-private-entry/admission';
import { ImportSourceEvidence, ImportSourceOutcome } from '../rich-private-entry/source-confirm';
import type { MalApplyPage, MalOutcome, MalOwnVoteReadback, MalPreviewRow } from './contract';
import { MalCurrentAssignments } from './labels';
import { MalAction } from './controls';
import { malOriginalScoreLabel, malOutcomeLabel, malScoreOutcomeLabel, malVoteReadKey } from './meaning';
import { malSourcePreview } from './source';

function currentVoteLabel(row: MalPreviewRow | undefined, readback?: MalOwnVoteReadback): string {
  if (readback) {
    if (readback.kind === 'current')
      return m.library_mal_vote_present({ units: readback.units, revision: readback.revision, at: readback.at });
    if (readback.kind === 'cleared') return m.library_mal_vote_cleared();
    if (readback.kind === 'missing') return m.library_mal_vote_none();
    return m.library_mal_vote_unavailable();
  }
  if (row?.currentScoreVote === null) return m.library_mal_vote_none();
  if (row?.currentScoreVote !== undefined) {
    if (row.currentScoreVote.units === null) return m.library_mal_vote_cleared();
    return m.library_mal_vote_present({
      units: row.currentScoreVote.units,
      revision: row.currentScoreVote.revision,
      at: row.currentScoreVote.at,
    });
  }
  return m.library_mal_vote_unavailable();
}

function Outcome({
  outcome,
  titles,
  admission,
  row,
  questionId,
  voteReadback,
  busy,
  onReadVote,
}: {
  outcome: MalOutcome;
  titles: Map<number, string>;
  admission: SourceAdmissionOutcome | null | undefined;
  row: MalPreviewRow | undefined;
  questionId: string | null;
  voteReadback?: MalOwnVoteReadback | undefined;
  busy: boolean;
  onReadVote: (row: MalPreviewRow) => void;
}) {
  const score = outcome.score;
  const reviewedScore = row?.review?.score;
  const targetId = row?.review?.target ?? row?.target;
  return (
    <li className="rounded-md border p-3" data-mal-outcome={outcome.status} data-mal-row={outcome.row}>
      <p className="font-medium [overflow-wrap:anywhere]">{titles.get(outcome.row) ?? `#${outcome.row + 1}`}</p>
      <p>{m.library_mal_row_outcome({ status: malOutcomeLabel(outcome.status) })}</p>
      <p className="text-sm">
        {m.library_mal_state_effect({
          effect: outcome.applied.includes('status') ? m.library_mal_result_applied() : m.library_mal_state_no_effect(),
        })}
      </p>
      {outcome.applied.length ? (
        <p className="text-sm">{m.library_mal_applied_fields({ fields: outcome.applied.join(', ') })}</p>
      ) : null}
      {outcome.retained.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2">{m.library_mal_retained_summary()}</summary>
          <p className="text-sm [overflow-wrap:anywhere]">{outcome.retained.join(', ')}</p>
        </details>
      ) : null}
      {outcome.reason ? <p className="text-sm text-muted-foreground">{outcome.reason}</p> : null}
      {outcome.labels ? (
        <ul className="space-y-2 [overflow-wrap:anywhere]" aria-label={m.library_mal_label_results()}>
          {outcome.labels.map((label) => (
            <li key={label.value}>
              #{label.value}: {label.status} · {label.reason}
              <p>
                {label.labelId} · {label.assignment?.id} · {label.assignment?.revision}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {outcome.remainingLabels?.length ? (
        <p>{m.library_mal_label_remaining({ values: outcome.remainingLabels.join(', ') })}</p>
      ) : null}
      {score ? (
        <section className="space-y-2 rounded-md bg-muted/40 p-3" aria-label={m.library_mal_score_receipt_label()}>
          <p className="font-medium">
            {m.library_mal_score_receipt({
              action:
                score.action === 'clear'
                  ? m.library_mal_score_clear()
                  : score.action === 'adopt'
                    ? m.library_mal_score_adopt_units({ units: reviewedScore?.units ?? '' })
                    : m.library_mal_score_no_action(),
              status: malScoreOutcomeLabel(score.status),
            })}
          </p>
          {score.vote ? (
            <p className="text-sm">
              {score.vote.units === null
                ? m.library_mal_vote_cleared()
                : m.library_mal_score_receipt_vote({
                    units: score.vote.units,
                    revision: score.vote.revision,
                    at: score.vote.at,
                  })}
            </p>
          ) : (
            <p className="text-sm">{m.library_mal_score_receipt_without_vote()}</p>
          )}
          {score.reason ? <p className="text-sm [overflow-wrap:anywhere]">{score.reason}</p> : null}
        </section>
      ) : (
        <p className="text-sm">{m.library_mal_score_effect_none()}</p>
      )}
      <section className="space-y-2 rounded-md border p-3">
        <p className="text-sm">{m.library_mal_current_vote_label({ value: currentVoteLabel(row, voteReadback) })}</p>
        {row && targetId && questionId ? (
          <MalAction type="button" variant="outline" disabled={busy} onClick={() => onReadVote(row)}>
            {m.library_mal_read_current_vote()}
          </MalAction>
        ) : null}
      </section>
      {row ? (
        <section className="space-y-1 rounded-md border p-3">
          <p className="font-medium">{m.library_mal_source_evidence_label()}</p>
          <p className="text-sm">{m.library_mal_source_score({ value: malOriginalScoreLabel(row.score) })}</p>
          <ImportSourceEvidence preview={row.sourcePreview ?? malSourcePreview(row)} />
        </section>
      ) : null}
      <ImportSourceOutcome outcome={admission} />
    </li>
  );
}

export function MalResultPage({
  result,
  titles,
  admissions,
  rows,
  questionId,
  voteReadbacks,
  busy,
  canRetry,
  canRetrySource,
  onRetry,
  onRetrySource,
  onReview,
  onReadVote,
}: {
  result: MalApplyPage;
  titles: Map<number, string>;
  admissions: Map<number, SourceAdmissionOutcome | null | undefined>;
  rows: MalPreviewRow[];
  questionId: string | null;
  voteReadbacks: Map<string, MalOwnVoteReadback>;
  busy: boolean;
  canRetry: boolean;
  canRetrySource: boolean;
  onRetry: () => void;
  onRetrySource: () => void;
  onReview: () => void;
  onReadVote: (row: MalPreviewRow) => void;
}) {
  const rowByIndex = new Map(rows.map((row) => [row.index, row]));
  return (
    <section className="space-y-4" data-mal-stage="results">
      {result.stopped ? <p role="status">{m.library_mal_stopped()}</p> : <p role="status">{m.library_mal_partial()}</p>}
      <ul className="space-y-3">
        {result.outcomes.map((outcome) => {
          const row = rowByIndex.get(outcome.row);
          const target = row?.review?.target;
          const rowQuestionId = row?.review?.score?.question.id ?? questionId;
          const voteReadback =
            row && target && rowQuestionId
              ? voteReadbacks.get(malVoteReadKey(row.index, target, rowQuestionId))
              : undefined;
          return (
            <Outcome
              key={outcome.row}
              outcome={outcome}
              titles={titles}
              admission={admissions.get(outcome.row)}
              row={row}
              questionId={rowQuestionId ?? null}
              voteReadback={voteReadback}
              busy={busy}
              onReadVote={onReadVote}
            />
          );
        })}
        {result.remaining.map((row) => (
          <li
            key={`remaining-${row}`}
            className="rounded-md border p-3"
            data-mal-outcome="unattempted"
            data-mal-row={row}
          >
            <p className="font-medium [overflow-wrap:anywhere]">{titles.get(row) ?? `#${row + 1}`}</p>
            <p>{m.library_mal_result_unattempted()}</p>
          </li>
        ))}
      </ul>
      {rows
        .filter(
          (row) =>
            row.outcome?.labels?.length ||
            result.outcomes.some((outcome) => outcome.row === row.index && outcome.labels?.length),
        )
        .map((row) => {
          const subjectId = row.review?.target ?? row.target;
          return subjectId ? (
            <MalCurrentAssignments
              key={`${row.index}:${subjectId}:${JSON.stringify(result.outcomes)}`}
              subjectId={subjectId}
            />
          ) : null;
        })}
      <div className="flex flex-wrap gap-3">
        <MalAction type="button" variant="outline" disabled={busy} onClick={onReview}>
          {m.library_mal_return_review()}
        </MalAction>
        {canRetry ? (
          <MalAction type="button" disabled={busy} onClick={onRetry}>
            {m.library_mal_retry_command()}
          </MalAction>
        ) : null}
        {canRetrySource ? (
          <MalAction type="button" variant="outline" disabled={busy} onClick={onRetrySource}>
            {m.library_mal_retry_source_evidence()}
          </MalAction>
        ) : null}
      </div>
    </section>
  );
}
