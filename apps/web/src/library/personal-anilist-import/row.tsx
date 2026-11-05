import { useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { AniListRow, AniListRowMeta, AniListScoreFormat } from './contract';
import { AniListAction, AniListCheck } from './controls';
import { AniListEvidencePanel } from './fields';
import {
  aniListCanChooseTarget,
  aniListHasAdmittedStatus,
  aniListMatchLabel,
  aniListMediaLabel,
  aniListMediaType,
  aniListNeedsReplace,
  aniListTitle,
  aniListValidityLabel,
} from './meaning';
import { AniListTargetSearch } from './target';
import type { AniListQuestion } from './contract';

export type RowDraft = {
  ordinal: number;
  target: string | null;
  skip: boolean;
  replace: boolean;
  applyStatus: boolean;
  scoreAction: 'keep' | 'vote' | 'clear';
  scoreUnits: number | null;
};

export function draftFromMeta(row: AniListRow, meta?: AniListRowMeta): RowDraft {
  return {
    ordinal: row.ordinal,
    target: meta?.target ?? row.review?.input.subjectId ?? null,
    skip: meta?.skip ?? false,
    replace: meta?.replace ?? false,
    applyStatus: meta?.applyStatus ?? true,
    scoreAction: meta?.scoreAction ?? 'keep',
    scoreUnits: meta?.scoreUnits ?? null,
  };
}

function exactScore(value: unknown, lexeme: string | null): string {
  if (lexeme !== null) return lexeme;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function currentReadback(value: unknown): {
  status: 'current' | 'unavailable';
  units: number | null;
  reason?: string;
  questionLabel?: string;
  questionRevision?: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const score = value as Record<string, unknown>;
  if (score.status === 'unavailable')
    return {
      status: 'unavailable',
      units: null,
      ...(typeof score.reason === 'string' ? { reason: score.reason } : {}),
    };
  if (score.status !== 'current') return null;
  const question =
    score.question && typeof score.question === 'object' ? (score.question as Record<string, unknown>) : {};
  const questionLabel = typeof question.label === 'string' ? question.label : undefined;
  const questionRevision = typeof question.revision === 'number' ? question.revision : undefined;
  if (score.vote === null)
    return {
      status: 'current',
      units: null,
      ...(questionLabel === undefined ? {} : { questionLabel }),
      ...(questionRevision === undefined ? {} : { questionRevision }),
    };
  if (score.vote && typeof score.vote === 'object' && 'units' in score.vote && typeof score.vote.units === 'number')
    return {
      status: 'current',
      units: score.vote.units,
      ...(questionLabel === undefined ? {} : { questionLabel }),
      ...(questionRevision === undefined ? {} : { questionRevision }),
    };
  return null;
}

export function AniListRowReview({
  row,
  meta,
  scoreFormat,
  question,
  questionPending,
  questionNotice,
  busy,
  onSave,
  onChoose,
}: {
  row: AniListRow;
  meta?: AniListRowMeta;
  scoreFormat: AniListScoreFormat | null;
  question: AniListQuestion | null;
  questionPending: boolean;
  questionNotice: { kind: string } | null;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<RowDraft>(() => draftFromMeta(row, meta));
  const match = row.review?.match.state ?? row.match.state ?? meta?.match ?? null;
  const canTarget = aniListCanChooseTarget(match) && !draft.skip;
  const title = aniListTitle(row.source.evidence, m.library_anilist_untitled());
  const reviewed = !!(row.review || meta?.reviewId);
  const replaceable = aniListNeedsReplace(row) || !!meta?.current || meta?.scoreReview?.currentVote === 'present';
  const started = row.started || meta?.started === true;
  const mediaType = aniListMediaType(row.source.evidence);
  const readback = currentReadback(Object.hasOwn(row, 'currentScore') ? row.currentScore : meta?.currentScore);
  function update(next: RowDraft) {
    setDraft(next);
    onChoose(next);
  }
  return (
    <article
      className="space-y-4 rounded-lg border p-4"
      data-anilist-row={row.ordinal}
      data-anilist-match={match ?? 'pending'}
      data-anilist-started={started ? 'true' : 'false'}
    >
      <header className="space-y-1">
        <h3 className="text-lg font-medium [overflow-wrap:anywhere]">{title}</h3>
        <p className="text-sm text-muted-foreground">
          {aniListMediaLabel(mediaType)} · {aniListMatchLabel(match, draft.skip)}
        </p>
        {meta?.groupLabel ? (
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_anilist_group()}: {meta.groupLabel}
          </p>
        ) : null}
      </header>
      <AniListEvidencePanel row={row} scoreFormat={scoreFormat} />
      {meta?.scoreSource ? (
        <section className="space-y-3 rounded-md border p-3" data-anilist-score-review>
          <h4 className="font-medium">{m.library_anilist_score_review()}</h4>
          <p>
            {m.library_anilist_score_source({
              value: exactScore(meta.scoreSource.value, meta.scoreSource.lexeme),
              scale: meta.scoreSource.scale ?? m.library_anilist_score_scale_unknown(),
              validity: aniListValidityLabel(meta.scoreSource.validity),
            })}
          </p>
          {meta.scoreSource.value === 0 ? <p>{m.library_anilist_source_zero_unrated()}</p> : null}
          <p className="text-sm text-muted-foreground">{meta.scoreSource.reason}</p>
          {question ? (
            <div className="space-y-1">
              <p className="font-medium">{question.label}</p>
              <p>{question.meaning ?? m.library_anilist_question_meaning_unavailable()}</p>
              <p className="text-sm">
                {m.library_anilist_question_scale({
                  min: question.scale.min,
                  max: question.scale.max,
                  step: question.scale.displayStep,
                })}
              </p>
            </div>
          ) : (
            <p role="status">
              {questionPending
                ? m.library_anilist_question_loading()
                : questionNotice
                  ? m.library_anilist_question_unavailable()
                  : m.library_anilist_question_unavailable()}
            </p>
          )}
          {meta.scoreReview ? (
            <div className="space-y-1" data-anilist-reviewed-score-evidence>
              <p>
                {meta.scoreReview.currentVote === 'present'
                  ? m.library_anilist_review_vote_present({ units: meta.scoreReview.currentVoteUnits ?? 0 })
                  : meta.scoreReview.currentVote === 'absent'
                    ? m.library_anilist_review_vote_absent()
                    : m.library_anilist_review_vote_unavailable({
                        reason: meta.scoreReview.currentVoteReason ?? meta.scoreReview.availabilityReason ?? '',
                      })}
              </p>
              {meta.scoreReview.targetId ? (
                <p className="text-sm [overflow-wrap:anywhere]">
                  {m.library_anilist_score_target({ target: meta.scoreReview.targetId })}
                  {meta.scoreReview.identityEpoch ? ` · ${meta.scoreReview.identityEpoch}` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
          <fieldset className="space-y-2" disabled={busy || started}>
            <legend className="font-medium">{m.library_anilist_score_choice()}</legend>
            {(['keep', 'vote', 'clear'] as const).map((action) => {
              const id = `${base}-score-${action}`;
              return (
                <label key={action} htmlFor={id} className="flex min-h-11 items-center gap-3 [overflow-wrap:anywhere]">
                  <input
                    id={id}
                    type="radio"
                    name={`${base}-score-action`}
                    value={action}
                    checked={draft.scoreAction === action}
                    disabled={action !== 'keep' && !question}
                    onChange={() =>
                      update({
                        ...draft,
                        scoreAction: action,
                        scoreUnits: null,
                      })
                    }
                  />
                  {action === 'keep'
                    ? m.library_anilist_score_keep()
                    : action === 'vote'
                      ? m.library_anilist_score_vote()
                      : m.library_anilist_score_clear()}
                </label>
              );
            })}
            {draft.scoreAction === 'vote' && question ? (
              <label className="grid gap-1 sm:max-w-xs" htmlFor={`${base}-score-units`}>
                <span>{m.library_anilist_native_units()}</span>
                <input
                  id={`${base}-score-units`}
                  type="number"
                  min={question.scale.min}
                  max={question.scale.max}
                  step={question.scale.displayStep}
                  className="min-h-11 rounded-md border bg-background px-3"
                  value={draft.scoreUnits ?? ''}
                  placeholder={m.library_anilist_choose_native_units()}
                  onChange={(event) =>
                    update({
                      ...draft,
                      scoreUnits: event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
                    })
                  }
                />
                {draft.scoreUnits === 0 ? (
                  <span className="text-sm">{m.library_anilist_native_zero_is_vote()}</span>
                ) : null}
              </label>
            ) : null}
          </fieldset>
          {readback ? (
            <p role="status" data-anilist-current-score>
              {readback.status === 'unavailable'
                ? m.library_anilist_score_readback_unavailable({
                    reason: readback.reason ?? '',
                  })
                : readback.units === null
                  ? m.library_anilist_score_readback_absent()
                  : m.library_anilist_score_readback_vote({ units: readback.units! })}
              {readback.questionLabel ? ` · ${readback.questionLabel}` : ''}
              {readback.questionRevision !== undefined
                ? ` · ${m.library_anilist_question_revision({ revision: readback.questionRevision })}`
                : ''}
            </p>
          ) : row.review?.score ? (
            <p>{m.library_anilist_score_readback_pending()}</p>
          ) : null}
        </section>
      ) : null}
      {row.proposal?.current || meta?.current ? (
        <p>
          {m.library_anilist_current({
            state: (row.proposal?.current ?? meta?.current)!.state,
            revision: (row.proposal?.current ?? meta?.current)!.revision,
          })}
        </p>
      ) : (
        <p>{m.library_anilist_absence()}</p>
      )}
      {(row.proposal?.proposedState ?? meta?.proposedState) ? (
        <p>{m.library_anilist_proposed({ state: (row.proposal?.proposedState ?? meta?.proposedState)! })}</p>
      ) : meta?.repeating ? (
        <p>{m.library_anilist_repeating_status()}</p>
      ) : (
        <p>{m.library_anilist_unsupported_status()}</p>
      )}
      {replaceable ? <p>{m.library_anilist_conflict_entry()}</p> : null}
      {!aniListHasAdmittedStatus(row) ? <p>{m.library_anilist_empty_fields()}</p> : null}
      {meta?.target && row.review?.input.subjectId && meta.target !== row.review.input.subjectId ? (
        <p>{m.library_anilist_changed_target()}</p>
      ) : null}
      {started ? <p>{m.library_anilist_started_locked()}</p> : null}
      {canTarget && !started ? (
        <AniListTargetSearch disabled={busy} value={draft.target} onChange={(target) => update({ ...draft, target })} />
      ) : null}
      <AniListCheck
        id={`${base}-skip`}
        checked={draft.skip}
        disabled={busy || started}
        label={m.library_anilist_skip_row()}
        onToggle={(skip) => update({ ...draft, skip, replace: skip ? false : draft.replace, applyStatus: !skip })}
      />
      {!draft.skip && !started ? (
        <AniListCheck
          id={`${base}-status`}
          checked={draft.applyStatus}
          disabled={busy}
          label={m.library_anilist_apply_status()}
          onToggle={(applyStatus) => update({ ...draft, applyStatus })}
        />
      ) : null}
      {replaceable && !draft.skip && !started ? (
        <AniListCheck
          id={`${base}-replace`}
          checked={draft.replace}
          disabled={busy || !reviewed}
          label={
            meta?.scoreReview?.currentVote === 'present'
              ? m.library_anilist_replace_vote_and_state()
              : m.library_anilist_replace()
          }
          onToggle={(replace) => update({ ...draft, replace })}
        />
      ) : null}
      <AniListAction
        type="button"
        disabled={busy || started || (draft.scoreAction === 'vote' && draft.scoreUnits === null)}
        onClick={() => onSave(draft)}
      >
        {m.library_anilist_save_review()}
      </AniListAction>
    </article>
  );
}
