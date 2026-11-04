import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { VndbScoreNotice } from './controller';
import type { VndbReviewInput, VndbRow } from './contract';
import { VndbAction, VndbCheck } from './controls';

type ScoreReview = Extract<VndbReviewInput, { action: 'score' }>;

function sourceScore(row: VndbRow) {
  return row.fields.score ?? { kind: 'missing' as const, raw: null };
}

function currentVoteLabel(row: VndbRow): string {
  const vote = row.nativeScore.currentVote;
  if (vote.state === 'set') return m.library_vndb_score_current_set({ units: vote.units, revision: vote.revision });
  if (vote.state === 'cleared') return m.library_vndb_score_current_cleared({ revision: vote.revision });
  if (vote.state === 'absent') return m.library_vndb_score_current_absent();
  return m.library_vndb_score_current_unavailable();
}

function sourceIsSupported(row: VndbRow): boolean {
  const value = sourceScore(row);
  return (
    row.kind === 'vn' &&
    value.kind === 'value' &&
    typeof value.value === 'number' &&
    value.scale?.min === 1 &&
    value.scale.max === 10 &&
    value.scale.step === 0.1
  );
}

function sourceText(row: VndbRow): string {
  const value = sourceScore(row);
  if (value.kind === 'missing') return m.library_vndb_value_missing();
  if (value.kind === 'unknown') return m.library_vndb_value_unknown();
  if (value.kind === 'invalid') return m.library_vndb_value_invalid();
  return value.raw ?? String(value.value ?? '');
}

function noticeText(notice: VndbScoreNotice): string {
  if (notice.reason === 'native-current-vote-changed') return m.library_vndb_score_review_notice_changed();
  if (notice.reason === 'native-current-vote-unavailable') return m.library_vndb_score_review_notice_vote();
  return m.library_vndb_score_review_notice_question();
}

export function VndbScoreReview({
  row,
  busy,
  scoreNotice,
  targetId,
  onReview,
}: {
  row: VndbRow;
  busy: boolean;
  scoreNotice?: VndbScoreNotice;
  targetId: string | null;
  onReview: (body: ScoreReview) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState<'vote' | 'clear' | ''>('');
  const [units, setUnits] = useState('');
  const [consent, setConsent] = useState(false);
  const [replace, setReplace] = useState(false);
  const native = row.nativeScore;
  const question = native.question;
  const source = sourceScore(row);
  const sourceSupported = sourceIsSupported(row);
  const supportedMeaning = row.kind === 'vn' && !!question && !!question.meaning?.trim() && question.grain === 'work';
  const previewTarget = row.target?.targetId ?? null;
  const exactCandidate =
    supportedMeaning &&
    sourceSupported &&
    native.exactUnits !== null &&
    Number.isSafeInteger(native.exactUnits) &&
    native.exactUnits >= question.scale.min &&
    native.exactUnits <= question.scale.max &&
    (native.exactUnits - question.scale.min) % question.scale.step === 0
      ? native.exactUnits
      : null;
  const currentSet = native.currentVote.state === 'set';
  const targetMatchesPreview = !!targetId && targetId === previewTarget;
  const canReview =
    targetMatchesPreview &&
    supportedMeaning &&
    native.currentVote.state !== 'unavailable' &&
    ((choice === 'vote' && exactCandidate !== null && units !== '' && (!currentSet || replace)) ||
      (choice === 'clear' && currentSet));
  const scoreDecision = row.scoreDecision;

  useEffect(() => {
    setChoice('');
    setUnits('');
    setConsent(false);
    setReplace(false);
  }, [row.ordinal, targetId, question?.id, question?.revision, native.currentVote]);

  function review() {
    if (!canReview || !question || !targetId) return;
    const selection =
      choice === 'vote' ? { kind: 'vote' as const, units: Number(units) } : { kind: 'clear' as const };
    onReview({
      ordinal: row.ordinal,
      action: 'score',
      targetId,
      questionId: question.id,
      questionRevision: question.revision,
      selection,
      consent: choice === 'vote' ? 'adopt-native-vote' : 'clear-native-vote',
    });
  }

  return (
    <section
      className="min-w-0 space-y-3 rounded-md border p-3"
      data-vndb-score-review={scoreDecision?.status ?? (scoreNotice?.reviewId ? 'stale' : 'pending')}
    >
      <h4 className="font-medium">{m.library_vndb_score_title()}</h4>
      <p className="break-words text-sm">{m.library_vndb_score_source({ value: sourceText(row) })}</p>
      {source.scale ? (
        <p className="text-sm text-muted-foreground">
          {m.library_vndb_score_scale({ min: source.scale.min, max: source.scale.max, step: source.scale.step })}
        </p>
      ) : null}
      {question ? (
        <div className="space-y-1 text-sm">
          <p className="break-words font-medium">{m.library_vndb_score_question({ label: question.label })}</p>
          <p className="break-words">{m.library_vndb_score_meaning({ meaning: question.meaning ?? m.library_vndb_score_meaning_unknown() })}</p>
          <p className="break-words text-muted-foreground">
            {m.library_vndb_score_question_basis({
              id: question.id,
              revision: question.revision,
              grain: question.grain,
              min: question.scale.min,
              max: question.scale.max,
              step: question.scale.step,
            })}
          </p>
        </div>
      ) : (
        <p role="status">{m.library_vndb_score_question_unavailable()}</p>
      )}
      <p className="break-words text-sm">{currentVoteLabel(row)}</p>
      {previewTarget ? <p className="break-words text-sm">{m.library_vndb_target_id({ id: previewTarget })}</p> : null}
      {row.kind === 'vn' && source.kind === 'value' && !sourceSupported ? (
        <p className="break-words text-sm text-muted-foreground">{m.library_vndb_score_source_unsupported()}</p>
      ) : null}
      {source.kind === 'invalid' && source.raw === '0' ? (
        <p className="break-words text-sm text-muted-foreground">{m.library_vndb_score_zero_clear()}</p>
      ) : null}
      {row.kind !== 'vn' ? <p>{m.library_vndb_score_not_vn()}</p> : null}
      {!targetMatchesPreview ? <p role="status">{m.library_vndb_score_target_unavailable()}</p> : null}
      {sourceSupported && exactCandidate !== null ? (
        <p className="break-words text-sm">{m.library_vndb_score_exact_candidate({ units: exactCandidate })}</p>
      ) : sourceSupported ? (
        <p className="break-words text-sm">{m.library_vndb_score_no_exact_candidate()}</p>
      ) : null}
      <p className="break-words text-sm text-muted-foreground">{m.library_vndb_score_apply_unavailable()}</p>
      {scoreDecision ? (
        <div className="space-y-1 rounded-sm bg-muted/40 p-2 text-sm" data-vndb-score-decision={scoreDecision.reviewId}>
          <p role="status">{m.library_vndb_score_reviewed({ status: scoreDecision.status })}</p>
          <p>
            {scoreDecision.action === 'vote'
              ? m.library_vndb_score_selected_vote({ units: scoreDecision.units ?? 0 })
              : m.library_vndb_score_selected_clear()}
          </p>
          <p className="break-words">{m.library_vndb_score_receipt({ id: scoreDecision.reviewId })}</p>
          <p className="break-words">{m.library_vndb_target_id({ id: scoreDecision.targetId })}</p>
        </div>
      ) : null}
      {scoreNotice ? (
        <div role="status" className="space-y-1">
          <p>{noticeText(scoreNotice)}</p>
          {scoreNotice.reviewId ? <p className="break-words text-sm">{m.library_vndb_score_receipt({ id: scoreNotice.reviewId })}</p> : null}
        </div>
      ) : null}
      {targetMatchesPreview && supportedMeaning && native.currentVote.state !== 'unavailable' ? (
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="font-medium">{m.library_vndb_score_choose()}</legend>
          <div className="flex flex-wrap gap-2">
            <VndbAction
              type="button"
              variant={choice === 'vote' ? 'default' : 'outline'}
              aria-pressed={choice === 'vote'}
              onClick={() => {
                setChoice('vote');
                setUnits('');
                setConsent(false);
                setReplace(false);
              }}
              disabled={!sourceSupported || exactCandidate === null}
            >
              {m.library_vndb_score_use_candidate()}
            </VndbAction>
            <VndbAction
              type="button"
              variant={choice === 'clear' ? 'default' : 'outline'}
              aria-pressed={choice === 'clear'}
              onClick={() => {
                setChoice('clear');
                setUnits('');
                setConsent(false);
                setReplace(false);
              }}
              disabled={!currentSet}
            >
              {m.library_vndb_score_clear()}
            </VndbAction>
          </div>
          {choice === 'vote' && question ? (
            <Field>
              <FieldLabel htmlFor={`${id}-units`} className="min-h-11 items-center">
                {m.library_vndb_score_units()}
              </FieldLabel>
              <select
                id={`${id}-units`}
                className="min-h-11 w-full rounded-md border bg-background px-3"
                value={units}
                onChange={(event) => {
                  setUnits(event.currentTarget.value);
                  setConsent(false);
                }}
              >
                <option value="">{m.library_vndb_score_select_units()}</option>
                {exactCandidate !== null ? <option value={exactCandidate}>{exactCandidate}</option> : null}
              </select>
            </Field>
          ) : null}
          {currentSet ? (
            <VndbCheck
              id={`${id}-replace`}
              checked={replace}
              disabled={busy || choice !== 'vote'}
              label={m.library_vndb_score_replace_vote()}
              onToggle={(checked) => {
                setReplace(checked);
                setConsent(false);
              }}
            />
          ) : null}
          {choice ? (
            <VndbCheck
              id={`${id}-consent`}
              checked={consent}
              label={choice === 'vote' ? m.library_vndb_score_consent_vote() : m.library_vndb_score_consent_clear()}
              onToggle={setConsent}
            />
          ) : null}
          <VndbAction type="button" disabled={!canReview || !consent || busy} onClick={review}>
            {m.library_vndb_score_save_review()}
          </VndbAction>
        </fieldset>
      ) : null}
    </section>
  );
}
