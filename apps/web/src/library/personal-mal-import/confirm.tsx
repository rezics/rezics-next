import { useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { ImportSourceChecks, ImportSourceEvidence } from '../rich-private-entry/source-confirm';
import type { MalOwnVoteReadback, MalPreviewRow, MalQuestion } from './contract';
import { MalAction } from './controls';
import { malKindLabel, malMatchLabel, malOriginalScoreLabel, malVoteReadKey } from './meaning';
import { MalReviewedLabels } from './labels';
import { malSourcePreview } from './source';
import type { RowDraft } from './row';

export function MalConfirmPage({
  rows,
  busy,
  confirmPrivacy,
  confirmTimestamps,
  drafts,
  question,
  voteReadbacks,
  onBack,
  onConfirm,
  onConfirmSource,
}: {
  rows: MalPreviewRow[];
  busy: boolean;
  confirmPrivacy: boolean;
  confirmTimestamps: boolean;
  drafts: Record<number, RowDraft>;
  question: MalQuestion | null;
  voteReadbacks: Map<string, MalOwnVoteReadback>;
  onBack: () => void;
  onConfirm: (scoreConsents: Set<string>) => void;
  onConfirmSource: (choice: { privacy?: boolean; timestamps?: boolean }) => void;
}) {
  const [scoreConsents, setScoreConsents] = useState<Set<string>>(() => new Set());
  const ready = rows.filter((row) => row.review);
  const scoreRows = ready.filter((row) => {
    const score = row.review?.score;
    return (
      score &&
      !row.review?.skip &&
      (score.action !== 'adopt' || score.units !== null) &&
      row.scoreReviewState === 'observations-match' &&
      score.support.status === 'supported' &&
      score.admission.status === 'conditional'
    );
  });
  const gated =
    busy ||
    ready.length === 0 ||
    !confirmPrivacy ||
    !confirmTimestamps ||
    scoreRows.some((row) => {
      const key = scoreConsentKey(row);
      return key !== null && !scoreConsents.has(key);
    });
  return (
    <section className="space-y-4" data-mal-stage="confirm">
      <p>{m.library_mal_confirm_help({ count: ready.length })}</p>
      <ul className="space-y-3">
        {ready.map((row) => {
          const review = row.review!;
          const draft = drafts[row.index];
          const stateSelected = !review.skip && !!draft?.fields.includes('status');
          const fields = review.skip ? [] : stateSelected ? ['status'] : [];
          const score = review.score;
          const nativeQuestion = question ?? score?.question;
          const scoreKey = scoreConsentKey(row);
          const scoreAvailable = scoreRows.includes(row);
          const questionText = question
            ? m.library_mal_question_details({
                label: question.label,
                revision: question.revision,
                grain: question.grain,
                meaning: question.meaning ?? '',
                min: question.scale.min,
                max: question.scale.max,
                step: question.scale.displayStep,
              })
            : score
              ? m.library_mal_question_details({
                  label: score.question.label,
                  revision: score.question.revision,
                  grain: score.question.grain,
                  meaning: score.question.meaning ?? '',
                  min: score.question.scale.minimumUnits,
                  max: score.question.scale.maximumUnits,
                  step: score.question.scale.stepUnits,
                })
              : null;
          const target = review.target ?? row.target;
          const questionId = nativeQuestion?.id;
          const readback =
            target && questionId ? voteReadbacks.get(malVoteReadKey(row.index, target, questionId)) : undefined;
          const currentVote = currentVoteLabel(row, score, nativeQuestion?.id, readback);
          return (
            <li key={row.index} className="rounded-md border p-3">
              <p className="font-medium [overflow-wrap:anywhere]">{row.title}</p>
              <p className="text-sm">
                {malKindLabel(row.kind)} · {malMatchLabel(row.match, review.skip)}
              </p>
              <p className="text-sm">
                {m.library_mal_state_effect({
                  effect: review.skip
                    ? m.library_mal_match_skipped()
                    : fields.includes('status')
                      ? (review.state ?? m.library_mal_unsupported_status())
                      : m.library_mal_state_kept(),
                })}
              </p>
              <p className="text-sm">
                {m.library_mal_retained_evidence({
                  fields: row.retained.map((item) => item.field).join(', ') || m.library_mal_none(),
                })}
              </p>
              <div className="space-y-2 rounded-md bg-muted/40 p-3">
                <p className="text-sm">{m.library_mal_source_score({ value: malOriginalScoreLabel(row.score) })}</p>
                {questionText ? (
                  <p className="text-sm [overflow-wrap:anywhere]">{questionText}</p>
                ) : (
                  <p role="status">{m.library_mal_question_unavailable()}</p>
                )}
                <p className="text-sm">{m.library_mal_current_vote_label({ value: currentVote })}</p>
              </div>
              {score ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="font-medium">
                    {m.library_mal_score_effect_preview({
                      choice:
                        score.action === 'clear'
                          ? m.library_mal_score_clear()
                          : m.library_mal_score_adopt_units({ units: score.units ?? '' }),
                    })}
                  </p>
                  {scoreAvailable && scoreKey ? (
                    <label className="flex min-h-11 items-center gap-3 whitespace-normal [overflow-wrap:anywhere]">
                      <input
                        className="size-5 shrink-0"
                        type="checkbox"
                        checked={scoreConsents.has(scoreKey)}
                        disabled={busy || review.skip}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setScoreConsents((current) => {
                            const next = new Set(current);
                            if (checked) next.add(scoreKey);
                            else next.delete(scoreKey);
                            return next;
                          });
                        }}
                      />
                      {m.library_mal_score_consent()}
                    </label>
                  ) : (
                    <p role="status">
                      {m.library_mal_score_review_unavailable()}
                      {score.admission.reason ? ` · ${score.admission.reason}` : ''}
                    </p>
                  )}
                  {!scoreAvailable && row.scoreReviewState === 'stale' ? (
                    <p role="status">{m.library_mal_score_review_stale()}</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm">{m.library_mal_score_effect_none()}</p>
              )}
              {review.target ? <p className="text-sm [overflow-wrap:anywhere]">{review.target}</p> : null}
              <p className="break-all">{review.version}</p>
              <MalReviewedLabels review={review.labels} />
              <p className="text-sm font-medium">{m.library_mal_source_evidence_label()}</p>
              <ImportSourceEvidence preview={row.sourcePreview ?? malSourcePreview(row)} />
            </li>
          );
        })}
      </ul>
      <ImportSourceChecks
        prefix="mal"
        privacy={confirmPrivacy}
        timestamps={confirmTimestamps}
        disabled={busy}
        onPrivacy={(privacy) => onConfirmSource({ privacy })}
        onTimestamps={(timestamps) => onConfirmSource({ timestamps })}
      />
      <div className="flex flex-wrap gap-3">
        <MalAction type="button" variant="outline" disabled={busy} onClick={onBack}>
          {m.library_mal_return_review()}
        </MalAction>
        <MalAction type="button" disabled={gated} onClick={() => onConfirm(new Set(scoreConsents))} aria-busy={busy}>
          {busy ? m.library_mal_confirming() : m.library_mal_confirm()}
        </MalAction>
      </div>
    </section>
  );
}

function currentVoteLabel(
  row: MalPreviewRow,
  score: NonNullable<NonNullable<MalPreviewRow['review']>['score']> | undefined,
  questionId: string | undefined,
  readback: MalOwnVoteReadback | undefined,
): string {
  if (readback) return readbackLabel(readback);
  if ((!score || score.question.id === questionId) && row.currentScoreVote !== undefined) {
    if (row.currentScoreVote === null) return m.library_mal_vote_none();
    if (row.currentScoreVote.units === null) return m.library_mal_vote_cleared();
    return m.library_mal_vote_present({
      units: row.currentScoreVote.units,
      revision: row.currentScoreVote.revision,
      at: row.currentScoreVote.at,
    });
  }
  if (score && score.question.id === questionId) {
    if (score.baseline.state === 'absent') return m.library_mal_vote_none();
    if (score.baseline.state === 'cleared') return m.library_mal_vote_cleared();
    return m.library_mal_vote_present({
      units: score.baseline.units!,
      revision: score.baseline.revision!,
      at: score.baseline.at!,
    });
  }
  return m.library_mal_vote_unavailable();
}

function readbackLabel(readback: MalOwnVoteReadback): string {
  if (readback.kind === 'current')
    return m.library_mal_vote_present({ units: readback.units, revision: readback.revision, at: readback.at });
  if (readback.kind === 'cleared') return m.library_mal_vote_cleared();
  if (readback.kind === 'missing') return m.library_mal_vote_none();
  return m.library_mal_vote_unavailable();
}

export function scoreConsentKey(row: MalPreviewRow): string | null {
  const review = row.review;
  const score = review?.score;
  if (!review || !score || !review.target) return null;
  return JSON.stringify([
    row.index,
    review.target,
    score.question.id,
    score.question.revision,
    score.action,
    score.units,
    score.replaceCurrent === true,
    review.version,
  ]);
}
