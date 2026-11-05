import { m } from '../../paraglide/messages.js';
import type {
  BangumiEntryReadback,
  BangumiScoreOutcome,
  BangumiScoreReview,
  BangumiScoreSelection,
  BangumiRowMeta,
  BangumiVoteReadback,
} from './contract';
import { BangumiCheck } from './controls';
import { bangumiOutcomeLabel } from './meaning';

export type BangumiScoreDraft = { action: 'preserve' | 'set' | 'clear'; units: string };

export function scoreDraftFrom(review?: BangumiScoreReview | null): BangumiScoreDraft {
  const selection = review?.native.selection ?? { action: 'preserve' as const };
  const current = review?.native.currentVote;
  return {
    action: selection.action,
    units: selection.action === 'set' ? String(selection.units) : current?.state === 'set' ? String(current.units) : '',
  };
}

export function scoreSelectionFromDraft(
  draft: BangumiScoreDraft,
  review: BangumiScoreReview | null | undefined,
  hasTarget = true,
): BangumiScoreSelection | null {
  if (draft.action === 'preserve') return { action: 'preserve' };
  if (!hasTarget || !review?.native.question) return null;
  if (draft.action === 'clear') return { action: 'clear' };
  if (!draft.units.trim()) return null;
  const units = Number(draft.units);
  const { minimum, maximum, step } = review.native.question.scale;
  if (!Number.isSafeInteger(units) || units < minimum || units > maximum || (units - minimum) % step !== 0) return null;
  return { action: 'set', units };
}

function sourceValue(value: unknown): string {
  if (value === undefined) return m.library_bangumi_missing();
  if (value === null) return m.library_bangumi_unknown();
  return String(value);
}

function scoreAction(action: BangumiScoreSelection['action']): string {
  if (action === 'set') return m.library_bangumi_score_set();
  if (action === 'clear') return m.library_bangumi_score_clear();
  return m.library_bangumi_score_preserve();
}

function scoreStatus(status: BangumiScoreOutcome['status']): string {
  return status === 'unavailable' ? m.library_bangumi_score_result_unavailable() : bangumiOutcomeLabel(status);
}

function scoreGrain(grain: NonNullable<BangumiScoreReview['native']['question']>['grain']): string {
  if (grain === 'work') return m.library_bangumi_score_grain_work();
  if (grain === 'release') return m.library_bangumi_score_grain_release();
  if (grain === 'episode') return m.library_bangumi_score_grain_episode();
  return m.library_bangumi_score_grain_character();
}

export function BangumiScoreReviewPanel({
  review,
  hasTarget,
  draft,
  base,
  disabled,
  onChange,
}: {
  review: BangumiScoreReview;
  hasTarget: boolean;
  draft: BangumiScoreDraft;
  base: string;
  disabled: boolean;
  onChange: (draft: BangumiScoreDraft) => void;
}) {
  const question = review.native.question;
  const current = review.native.currentVote;
  const validSelection = scoreSelectionFromDraft(draft, review, hasTarget);
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label={m.library_bangumi_score_title()}>
      <h4 className="font-medium">{m.library_bangumi_score_title()}</h4>
      <p className="text-sm [overflow-wrap:anywhere]">
        {m.library_bangumi_score_source({
          state:
            review.source.state === 'score'
              ? m.library_bangumi_score_source_scored()
              : review.source.state === 'unrated'
                ? m.library_bangumi_score_source_unrated()
                : review.source.state === 'absent'
                  ? m.library_bangumi_score_source_absent()
                  : m.library_bangumi_score_source_unsupported(),
          value: sourceValue(review.source.value),
          min: review.source.scale.minimum,
          max: review.source.scale.maximum,
          reason: review.source.reason,
        })}
      </p>
      {hasTarget ? (
        <>
          {question ? (
            <div className="space-y-1 text-sm [overflow-wrap:anywhere]">
              <p>
                {m.library_bangumi_score_question({
                  label: question.label,
                  meaning: question.meaning ?? m.library_bangumi_unknown(),
                  grain: scoreGrain(question.grain),
                  revision: question.revision,
                  min: question.scale.minimum,
                  max: question.scale.maximum,
                  step: question.scale.step,
                })}
              </p>
              <p>{m.library_bangumi_score_question_id({ id: review.native.questionId })}</p>
            </div>
          ) : (
            <p className="text-sm">{m.library_bangumi_score_question_unavailable({ id: review.native.questionId })}</p>
          )}
          <p className="text-sm [overflow-wrap:anywhere]">
            {current === null
              ? m.library_bangumi_score_current_unknown()
              : current.state === 'absent'
                ? m.library_bangumi_score_current_absent()
                : current.state === 'cleared'
                  ? m.library_bangumi_score_current_cleared()
                  : m.library_bangumi_score_current_set({
                      units: current.units,
                      revision: current.revision,
                      at: current.at,
                    })}
          </p>
          <p className="text-sm [overflow-wrap:anywhere]">
            {review.native.admission.status === 'reviewed'
              ? m.library_bangumi_score_admission_reviewed({ reason: review.native.admission.reason })
              : m.library_bangumi_score_admission_unavailable({ reason: review.native.admission.reason })}
          </p>
        </>
      ) : null}
      <fieldset className="space-y-1" disabled={disabled}>
        <legend className="font-medium">{m.library_bangumi_score_action()}</legend>
        {(['preserve', 'set', 'clear'] as const).map((action) => (
          <label key={action} className="flex min-h-11 items-center gap-3 rounded-md px-2 py-2">
            <input
              type="radio"
              name={`${base}-score`}
              value={action}
              checked={draft.action === action}
              disabled={action !== 'preserve' && (!question || !hasTarget)}
              onChange={() => onChange({ ...draft, action })}
            />
            <span>{scoreAction(action)}</span>
          </label>
        ))}
      </fieldset>
      {draft.action === 'set' && question ? (
        <label className="grid gap-1 sm:max-w-xs">
          <span className="font-medium">{m.library_bangumi_score_units()}</span>
          <input
            className="min-h-11 rounded-md border bg-background px-3"
            type="number"
            inputMode="numeric"
            min={question.scale.minimum}
            max={question.scale.maximum}
            step={question.scale.step}
            value={draft.units}
            disabled={disabled || !hasTarget}
            onChange={(event) => onChange({ ...draft, units: event.currentTarget.value })}
          />
        </label>
      ) : null}
      {!hasTarget ? <p className="text-sm text-muted-foreground">{m.library_bangumi_score_choose_target()}</p> : null}
      {hasTarget && !question ? (
        <p className="text-sm text-muted-foreground">{m.library_bangumi_score_choose_preserve()}</p>
      ) : null}
      {draft.action === 'set' && question && hasTarget && !validSelection ? (
        <p className="text-sm text-muted-foreground">{m.library_bangumi_score_units_invalid()}</p>
      ) : null}
    </section>
  );
}

export function BangumiScoreConfirmation({
  row,
  disabled,
  onConsent,
}: {
  row: BangumiRowMeta;
  disabled: boolean;
  onConsent: (consent: boolean) => void;
}) {
  const review = row.scoreReview;
  const selection = review?.native.selection ?? { action: 'preserve' as const };
  const questionId = review?.native.questionId ?? null;
  const revision = review?.native.question?.revision;
  const missingTarget = selection.action !== 'preserve' && !row.target;
  const missingQuestion = selection.action !== 'preserve' && !review?.native.question;
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3" data-bangumi-score-confirm={row.ordinal}>
      {selection.action === 'set' ? (
        <p className="[overflow-wrap:anywhere]">
          {m.library_bangumi_score_confirm_set({
            units: selection.units,
            question: questionId ?? m.library_bangumi_score_question_missing(),
            revision: revision ?? m.library_bangumi_score_question_missing(),
          })}
        </p>
      ) : selection.action === 'clear' ? (
        <p className="[overflow-wrap:anywhere]">
          {m.library_bangumi_score_confirm_clear({
            question: questionId ?? m.library_bangumi_score_question_missing(),
            revision: revision ?? m.library_bangumi_score_question_missing(),
          })}
        </p>
      ) : (
        <p className="[overflow-wrap:anywhere]">
          {m.library_bangumi_score_confirm_preserve({
            question: questionId ?? m.library_bangumi_score_question_missing(),
          })}
        </p>
      )}
      {review?.native.admission.status === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">
          {m.library_bangumi_score_admission_unavailable({ reason: review.native.admission.reason })}
        </p>
      ) : review ? (
        <p className="text-sm text-muted-foreground">
          {m.library_bangumi_score_admission_reviewed({ reason: review.native.admission.reason })}
        </p>
      ) : null}
      {missingTarget ? (
        <p className="text-sm text-muted-foreground">{m.library_bangumi_score_choose_target()}</p>
      ) : null}
      {missingQuestion ? (
        <p className="text-sm text-muted-foreground">{m.library_bangumi_score_choose_preserve()}</p>
      ) : null}
      {selection.action !== 'preserve' ? (
        <BangumiCheck
          id={`bangumi-score-consent-${row.ordinal}`}
          checked={row.scoreConsent}
          disabled={disabled}
          label={
            selection.action === 'set'
              ? m.library_bangumi_score_consent_set({ units: selection.units, question: questionId ?? '' })
              : m.library_bangumi_score_consent_clear({ question: questionId ?? '' })
          }
          onToggle={onConsent}
        />
      ) : null}
    </div>
  );
}

export function BangumiScoreOutcomeView({ outcome }: { outcome: BangumiScoreOutcome }) {
  return (
    <div className="mt-2 rounded-md border p-3" data-bangumi-score-outcome={outcome.status}>
      <p>
        {m.library_bangumi_score_outcome({ action: scoreAction(outcome.action), status: scoreStatus(outcome.status) })}
      </p>
      {outcome.reason ? (
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{outcome.reason}</p>
      ) : null}
      {outcome.vote ? (
        <p className="text-sm [overflow-wrap:anywhere]">
          {m.library_bangumi_score_receipt_vote({
            units: outcome.vote.units,
            revision: outcome.vote.revision,
            at: outcome.vote.at,
          })}
        </p>
      ) : null}
    </div>
  );
}

export function BangumiCurrentFacts({
  entry,
  vote,
}: {
  entry: BangumiEntryReadback | null;
  vote: BangumiVoteReadback | null;
}) {
  if (!entry && !vote) return null;
  return (
    <section className="mt-3 space-y-2 rounded-md border p-3" aria-label={m.library_bangumi_current_facts()}>
      <h4 className="font-medium">{m.library_bangumi_current_facts()}</h4>
      {entry?.status === 'present' ? (
        <p className="[overflow-wrap:anywhere]">
          {m.library_bangumi_current({ state: entry.state, revision: entry.revision })}
        </p>
      ) : entry?.status === 'absent' ? (
        <p>{m.library_bangumi_absence()}</p>
      ) : entry ? (
        <p className="[overflow-wrap:anywhere]">
          {m.library_bangumi_entry_readback_unavailable({ reason: entry.reason })}
        </p>
      ) : null}
      {vote?.status === 'current' ? (
        vote.vote.state === 'set' ? (
          <p className="[overflow-wrap:anywhere]">
            {m.library_bangumi_score_readback_set({
              units: vote.vote.units,
              revision: vote.vote.revision,
              at: vote.vote.at,
            })}
          </p>
        ) : vote.vote.state === 'cleared' ? (
          <p>{m.library_bangumi_score_readback_cleared()}</p>
        ) : (
          <p>{m.library_bangumi_score_readback_absent()}</p>
        )
      ) : vote ? (
        <p className="[overflow-wrap:anywhere]">
          {m.library_bangumi_score_readback_unavailable({ reason: vote.reason })}
        </p>
      ) : null}
    </section>
  );
}
