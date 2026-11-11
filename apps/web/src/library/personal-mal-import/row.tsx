import { useId } from 'react';
import { ChoiceSelect } from '@rezics/ui/choice-select';
import { m } from '../../paraglide/messages.js';
import type {
  MalLabelSelection,
  MalOwnVoteReadback,
  MalPreviewRow,
  MalQuestion,
  MalScoreReviewInput,
} from './contract';
import { standardMalQuestion } from './contract';
import { MalAction, MalCheck } from './controls';
import {
  admittedFields,
  malKindLabel,
  malMatchLabel,
  malProgressEntries,
  malRetainReason,
  malOriginalScoreLabel,
  malValueLabel,
} from './meaning';
import { MalTargetSearch } from './target';
import { MalLabelsReview } from './labels';

type DraftScore =
  | (Omit<Extract<MalScoreReviewInput, { action: 'adopt' }>, 'units' | 'replaceCurrent'> & {
      units?: number | undefined;
      replaceCurrent?: boolean | undefined;
    })
  | Extract<MalScoreReviewInput, { action: 'clear' }>;

export type RowDraft = {
  row: number;
  target: string | null;
  skip: boolean;
  replace: boolean;
  score?: DraftScore | undefined;
  labels?: MalLabelSelection[];
  fields: string[];
};

export function draftFromRow(row: MalPreviewRow): RowDraft {
  const review = row.review;
  const score = review?.score;
  const standard = score ? standardMalQuestion(score.question) : null;
  const selection: RowDraft['score'] =
    score && standard
      ? score.action === 'adopt'
        ? {
            action: 'adopt',
            ...standard,
            ...(score.units !== null ? { units: score.units } : {}),
            ...(score.replaceCurrent ? { replaceCurrent: true } : {}),
          }
        : score.action === 'clear'
          ? { action: 'clear', ...standard }
          : undefined
      : undefined;
  return {
    row: row.index,
    target: review?.target ?? row.target,
    skip: review?.skip ?? false,
    replace: review?.replace ?? false,
    score: selection,
    ...(review?.labels
      ? {
          labels: review.labels.selections.flatMap((selection) =>
            selection.target ? [{ value: selection.value, target: selection.target }] : [],
          ),
        }
      : {}),
    fields: review ? (review.skip ? [] : admittedFields({ ...row, review })) : admittedFields(row),
  };
}

export function draftMatchesReview(row: MalPreviewRow, draft: RowDraft): boolean {
  const review = row.review;
  if (!review) {
    return (
      draft.target === row.target &&
      !draft.skip &&
      !draft.replace &&
      draft.score === undefined &&
      !draft.labels?.length &&
      [...draft.fields].sort().join(',') === [...admittedFields(row)].sort().join(',')
    );
  }
  if (draft.target !== review.target || draft.skip !== review.skip || draft.replace !== review.replace) return false;
  const saved = review.score;
  const selected = draft.score;
  const savedLabels =
    review.labels?.selections.flatMap((selection) =>
      selection.target ? [{ value: selection.value, target: selection.target }] : [],
    ) ?? [];
  const selectedLabels = draft.labels ?? [];
  const stableLabels = (labels: MalLabelSelection[]) =>
    JSON.stringify([...labels].sort((left, right) => left.value - right.value));
  if (stableLabels(savedLabels) !== stableLabels(selectedLabels)) return false;
  const savedFields = row.selectedFields ?? admittedFields(row);
  if ([...savedFields].sort().join(',') !== [...draft.fields].sort().join(',')) return false;
  if (!saved || !selected) return !saved && !selected;
  if (
    saved.action !== selected.action ||
    saved.question.id !== selected.questionId ||
    saved.question.revision !== selected.questionRevision
  )
    return false;
  if (selected.action === 'clear') return saved.units === null;
  if (selected.units === undefined) return saved.units === null;
  return saved.units === selected.units && saved.replaceCurrent === (selected.replaceCurrent === true);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="whitespace-normal [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function voteLabel(row: MalPreviewRow, target: string | null, readback?: MalOwnVoteReadback): string {
  if (readback) {
    if (readback.kind === 'current')
      return m.library_mal_vote_present({ units: readback.units, revision: readback.revision, at: readback.at });
    if (readback.kind === 'cleared') return m.library_mal_vote_cleared();
    if (readback.kind === 'missing') return m.library_mal_vote_none();
    return m.library_mal_vote_unavailable();
  }
  if (target !== (row.review?.target ?? row.target)) return m.library_mal_vote_unavailable();
  if (row.currentScoreVote !== undefined) {
    if (row.currentScoreVote === null) return m.library_mal_vote_none();
    return row.currentScoreVote.units === null
      ? m.library_mal_vote_cleared()
      : m.library_mal_vote_present({
          units: row.currentScoreVote.units,
          revision: row.currentScoreVote.revision,
          at: row.currentScoreVote.at,
        });
  }
  const baseline = row.review?.score?.baseline;
  if (!baseline) return m.library_mal_vote_unavailable();
  if (baseline.state === 'absent') return m.library_mal_vote_none();
  if (baseline.state === 'cleared') return m.library_mal_vote_cleared();
  return m.library_mal_vote_present({
    units: baseline.units!,
    revision: baseline.revision!,
    at: baseline.at!,
  });
}

function questionLabel(question: MalQuestion): string {
  return m.library_mal_question_details({
    label: question.label,
    revision: question.revision,
    grain: question.grain,
    meaning: question.meaning ?? '',
    min: question.scale.min,
    max: question.scale.max,
    step: question.scale.displayStep,
  });
}

export function MalRowReview({
  row,
  draft,
  question,
  voteReadback,
  busy,
  onChange,
  onSave,
  onReadCurrent,
}: {
  row: MalPreviewRow;
  draft: RowDraft;
  question: MalQuestion | null;
  voteReadback?: MalOwnVoteReadback | undefined;
  busy: boolean;
  onChange: (draft: RowDraft) => void;
  onSave: (draft: RowDraft) => void;
  onReadCurrent: () => void;
}) {
  const base = useId();
  const admitted = admittedFields(row);
  const canTarget = row.match !== 'unavailable';
  const canChooseQuestion = !!question && !!draft.target && !draft.skip;
  const currentScoreChoice =
    !!question &&
    row.scoreReviewState !== 'stale' &&
    draft.score?.questionId === question.id &&
    draft.score.questionRevision === question.revision;
  const sourceUnits = typeof row.score.value === 'number' ? row.score.value : Number.NaN;
  const canAdopt =
    row.score.kind === 'value' &&
    Number.isSafeInteger(sourceUnits) &&
    !!row.score.scale &&
    sourceUnits >= row.score.scale.min &&
    sourceUnits <= row.score.scale.max;
  const target = draft.target;
  const reviewedQuestion = row.review?.score?.question;
  const questionText = question
    ? questionLabel(question)
    : reviewedQuestion
      ? m.library_mal_question_details({
          label: reviewedQuestion.label,
          revision: reviewedQuestion.revision,
          grain: reviewedQuestion.grain,
          meaning: reviewedQuestion.meaning ?? '',
          min: reviewedQuestion.scale.minimumUnits,
          max: reviewedQuestion.scale.maximumUnits,
          step: reviewedQuestion.scale.stepUnits,
        })
      : null;
  return (
    <article className="space-y-4 rounded-lg border p-4" data-mal-row={row.index} data-mal-kind={row.kind}>
      <header className="space-y-1">
        <h3 className="text-lg font-medium [overflow-wrap:anywhere]">{row.title}</h3>
        <p className="text-sm text-muted-foreground">
          {malKindLabel(row.kind)} · {malMatchLabel(row.match, draft.skip)}
        </p>
        <p className="text-sm [overflow-wrap:anywhere]">
          {m.library_mal_identifier({ namespace: row.identifier.namespace, value: row.identifier.value })}
        </p>
      </header>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label={m.library_mal_status()} value={malValueLabel(row.status)} />
        <Fact label={m.library_mal_score()} value={malOriginalScoreLabel(row.score)} />
        {malProgressEntries(row).map((item) => (
          <Fact key={item.key} label={item.label} value={malValueLabel(item.value)} />
        ))}
        <Fact label={m.library_mal_started()} value={malValueLabel(row.dates.started ?? { kind: 'missing' })} />
        <Fact label={m.library_mal_finished()} value={malValueLabel(row.dates.finished ?? { kind: 'missing' })} />
        <Fact label={m.library_mal_repeats()} value={malValueLabel(row.repeats)} />
        <Fact label={m.library_mal_privacy()} value={malValueLabel(row.privacy)} />
      </dl>
      <p>{m.library_mal_not_vote()}</p>
      <p>{m.library_mal_not_session()}</p>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_mal_notes_summary()}</summary>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{malValueLabel(row.notes)}</p>
        <p className="mt-2 text-sm text-muted-foreground">{m.library_mal_not_review()}</p>
      </details>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_mal_retained_summary()}</summary>
        <ul className="mt-2 space-y-2">
          <li>
            {m.library_mal_tags()}: {malValueLabel(row.tags)}
          </li>
          {Object.entries(row.timestamps).map(([field, value]) => (
            <li key={field}>
              {field}: {malValueLabel(value)} · {m.library_mal_not_clock()}
            </li>
          ))}
          {row.retained.map((item) => (
            <li key={item.field}>
              {item.field}: {malRetainReason(item.reason)}
            </li>
          ))}
        </ul>
      </details>
      {row.current ? (
        <p>
          {m.library_mal_current({
            state: row.current.state,
            revision: row.current.revision,
          })}
        </p>
      ) : null}
      {row.state ? <p>{m.library_mal_proposed({ state: row.state })}</p> : <p>{m.library_mal_unsupported_status()}</p>}
      {row.review?.conflict ? <p>{m.library_mal_conflict_entry()}</p> : null}
      {canTarget && !draft.skip ? (
        <MalTargetSearch disabled={busy} value={target} onChange={(value) => onChange({ ...draft, target: value })} />
      ) : null}
      <MalCheck
        id={`${base}-skip`}
        checked={draft.skip}
        disabled={busy}
        label={m.library_mal_skip_row()}
        onToggle={(skip) =>
          onChange({
            ...draft,
            skip,
            score: skip ? undefined : draft.score,
            fields: skip
              ? []
              : [
                  ...new Set([
                    ...admitted.filter((field) => field === 'status'),
                    ...(draft.labels?.length ? ['tags'] : []),
                  ]),
                ],
          })
        }
      />
      {row.review?.conflict || row.match === 'already-matched' ? (
        <MalCheck
          id={`${base}-replace`}
          checked={draft.replace}
          disabled={busy || draft.skip}
          label={m.library_mal_replace_current()}
          onToggle={(replace) => onChange({ ...draft, replace })}
        />
      ) : null}
      {admitted.includes('status') ? (
        <MalCheck
          id={`${base}-status`}
          checked={draft.fields.includes('status')}
          disabled={busy || draft.skip}
          label={m.library_mal_select_status()}
          onToggle={(on) =>
            onChange({
              ...draft,
              fields: on
                ? [...new Set([...draft.fields, 'status'])]
                : draft.fields.filter((field) => field !== 'status'),
            })
          }
        />
      ) : null}

      <MalLabelsReview
        row={row}
        disabled={busy || draft.skip}
        labels={draft.labels}
        onChange={(labels) =>
          onChange({
            ...draft,
            labels,
            fields: [...draft.fields.filter((field) => field !== 'tags'), ...(labels.length ? ['tags'] : [])],
          })
        }
      />

      {questionText ? (
        <section className="space-y-3 rounded-md border p-3" aria-label={m.library_mal_native_score_question()}>
          <h4 className="font-medium">{m.library_mal_native_score_question()}</h4>
          <p className="whitespace-normal [overflow-wrap:anywhere]">{questionText}</p>
          <p>{m.library_mal_current_vote_label({ value: voteLabel(row, draft.target, voteReadback) })}</p>
          {row.review?.score && row.scoreReviewState === 'stale' ? (
            <p role="status">{m.library_mal_score_review_stale()}</p>
          ) : row.review?.score && row.scoreReviewState === 'unavailable' ? (
            <p role="status">{m.library_mal_score_review_unavailable()}</p>
          ) : null}
          {canChooseQuestion ? (
            <fieldset className="space-y-2">
              <legend className="font-medium">{m.library_mal_score_choice()}</legend>
              <label className="flex min-h-11 items-center gap-3 whitespace-normal [overflow-wrap:anywhere]">
                <input
                  className="size-5 shrink-0"
                  type="radio"
                  name={`${base}-score`}
                  checked={!draft.score}
                  disabled={busy}
                  onChange={() => onChange({ ...draft, score: undefined })}
                />
                {m.library_mal_score_keep()}
              </label>
              <label className="flex min-h-11 items-center gap-3 whitespace-normal [overflow-wrap:anywhere]">
                <input
                  className="size-5 shrink-0"
                  type="radio"
                  name={`${base}-score`}
                  checked={draft.score?.action === 'adopt' && currentScoreChoice}
                  disabled={busy || !canAdopt}
                  onChange={() => {
                    const standard = question ? standardMalQuestion(question) : null;
                    if (!standard) return;
                    onChange({
                      ...draft,
                      score: {
                        action: 'adopt',
                        ...standard,
                        ...(draft.score?.action === 'adopt' &&
                        draft.score.questionId === standard.questionId &&
                        draft.score.questionRevision === standard.questionRevision &&
                        draft.score.units !== undefined
                          ? { units: draft.score.units }
                          : {}),
                        ...(draft.score?.action === 'adopt' &&
                        draft.score.questionId === standard.questionId &&
                        draft.score.questionRevision === standard.questionRevision &&
                        draft.score.replaceCurrent
                          ? { replaceCurrent: true }
                          : {}),
                      },
                    });
                  }}
                />
                {m.library_mal_score_adopt()}
              </label>
              <label className="flex min-h-11 items-center gap-3 whitespace-normal [overflow-wrap:anywhere]">
                <input
                  className="size-5 shrink-0"
                  type="radio"
                  name={`${base}-score`}
                  checked={draft.score?.action === 'clear' && currentScoreChoice}
                  disabled={busy}
                  onChange={() => {
                    const standard = question ? standardMalQuestion(question) : null;
                    if (!standard) return;
                    onChange({
                      ...draft,
                      score: { action: 'clear', ...standard },
                    });
                  }}
                />
                {m.library_mal_score_clear()}
              </label>
              {draft.score?.action === 'adopt' ? (
                <div className="space-y-3">
                  <ChoiceSelect
                    id={`${base}-units`}
                    label={m.library_mal_score_units()}
                    fieldClassName="block space-y-1"
                    labelClassName="font-medium"
                    triggerClassName="min-h-11 w-full rounded-md border bg-background px-3"
                    value={draft.score.units === undefined ? null : String(draft.score.units)}
                    disabled={busy}
                    onValueChange={(value) =>
                      onChange({
                        ...draft,
                        score: {
                          ...draft.score!,
                          ...(value ? { units: Number(value) } : { units: undefined }),
                        },
                      })
                    }
                    options={[
                      { value: null, label: m.library_mal_score_choose_units() },
                      ...Array.from(
                        { length: (question.scale.max - question.scale.min) / question.scale.displayStep + 1 },
                        (_, index) => question.scale.min + index * question.scale.displayStep,
                      ).map((units) => ({ value: String(units), label: String(units) })),
                    ]}
                  />
                  <MalCheck
                    id={`${base}-replace-vote`}
                    checked={draft.score.replaceCurrent === true}
                    disabled={busy}
                    label={m.library_mal_score_replace()}
                    onToggle={(replaceCurrent) =>
                      onChange({
                        ...draft,
                        score: {
                          ...draft.score!,
                          ...(replaceCurrent ? { replaceCurrent: true } : { replaceCurrent: undefined }),
                        },
                      })
                    }
                  />
                </div>
              ) : null}
            </fieldset>
          ) : null}
          {target ? (
            <MalAction
              type="button"
              variant="outline"
              disabled={busy || (!question && !reviewedQuestion)}
              onClick={onReadCurrent}
            >
              {m.library_mal_read_current_vote()}
            </MalAction>
          ) : null}
        </section>
      ) : null}
      <MalAction
        type="button"
        disabled={busy || (draft.score?.action === 'adopt' && draft.score.units === undefined)}
        onClick={() => onSave(draft)}
      >
        {m.library_mal_save_review()}
      </MalAction>
    </article>
  );
}
