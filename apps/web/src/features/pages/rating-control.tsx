import { Button } from '@rezics/ui/shadcn/button';
import { Slider } from '@base-ui/react/slider';
import { Field } from '@base-ui/react/field';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { changeQuestionBoundRating, type QuestionBoundRatingInput } from './rating-actions';
import { sessionQueryKey, type BrowserSession } from '../../session';
import {
  personalScoreWriteCommand,
  personalScoreWriteNotice,
  type PersonalScoreWriteCommand,
  type PersonalScoreWriteResult,
} from '../../library/personal-score';
import { subjectOwnRatingQuery, subjectRatingQuery } from './subject-queries';
import { displayRating, type RatingQuestion, type SubjectOwnRating } from './subject-ratings';
import type { SubjectPersonalLease } from './subject-personal-reader';

export type RatingControlState =
  | { kind: 'unknown' }
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; units: number | null };

export type RatingWriteInput = Readonly<{
  units: number | null;
  idempotencyKey: string;
  expectedReader: string;
}>;
export type RatingWrite = (input: RatingWriteInput) => Promise<PersonalScoreWriteResult | boolean>;

export type RatingWriteFailure = { uncertain: boolean; stale?: boolean };

function writeOutcome(result: PersonalScoreWriteResult | boolean): PersonalScoreWriteResult {
  if (result === true) return 'successful';
  if (result === false) return 'rejected';
  return result;
}

function ratingNotice(locale: string, notice: ReturnType<typeof personalScoreWriteNotice>) {
  const options = { locale: locale as never };
  if (notice === 'uncertain') return m.subject_rating_control_uncertain({}, options);
  if (notice === 'stale') return m.subject_rating_control_stale({}, options);
  return m.subject_rating_control_error({}, options);
}

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';

export async function applyOptimisticRatingChange(input: {
  queryClient: ReturnType<typeof useQueryClient>;
  subjectId: string;
  locale: string;
  binding: SubjectPersonalLease;
  units: number | null;
  write: RatingWrite;
  request?: RatingWriteInput;
  onFailure: (result: RatingWriteFailure) => void;
  pendingCommand?: PersonalScoreWriteCommand | null;
}): Promise<boolean> {
  const { queryClient, subjectId, locale, binding, units, write, onFailure } = input;
  if (!binding.isCurrent() || binding.subjectId !== subjectId || binding.locale !== locale) return false;
  const ownQueryOptions = subjectOwnRatingQuery(subjectId, locale, binding.scope);
  const ownKey = ownQueryOptions.queryKey;
  const before = queryClient.getQueryData<SubjectOwnRating>(ownKey);
  const optimistic: SubjectOwnRating = { reader: binding.reader, kind: 'ready', units };
  const operation = binding.beginRatingWrite(before, optimistic);
  if (!operation || !binding.isCurrent()) return false;
  queryClient.setQueryData(ownKey, optimistic);
  const command = personalScoreWriteCommand(input.pendingCommand ?? null, units);
  const request = input.request
    ? { ...input.request, units, idempotencyKey: command.key }
    : { units, idempotencyKey: command.key, expectedReader: binding.reader };

  let outcome: PersonalScoreWriteResult = 'uncertain';
  try {
    outcome = writeOutcome(await write(request));
  } catch {
    if (binding.isCurrent()) {
      operation.preserveUncertainty(optimistic);
      onFailure({ uncertain: true });
    }
    return false;
  }
  if (!binding.isCurrent()) return false;
  if (outcome === 'successful') {
    operation.commit(optimistic);
    if (binding.isCurrent()) {
      void queryClient.invalidateQueries({ queryKey: ['personal-library-current'] });
      void queryClient.invalidateQueries({ queryKey: ['own-votes'] });
      void queryClient.invalidateQueries({ queryKey: ['collection-page'] });
      // Public figures publish asynchronously; refresh them in the background after the vote succeeds.
      void queryClient.invalidateQueries({ queryKey: subjectRatingQuery(subjectId, locale).queryKey }).catch(() => {});
    }
    return true;
  }
  if (outcome === 'uncertain') {
    operation.preserveUncertainty(optimistic);
    onFailure({ uncertain: true });
    return false;
  }
  const rollback = operation.rollback({ reader: binding.reader, kind: 'unavailable' });
  if (rollback) queryClient.setQueryData(ownKey, rollback);
  onFailure(outcome === 'stale' ? { uncertain: false, stale: true } : { uncertain: false });
  return false;
}

export function RatingControlView({
  question,
  subjectId,
  locale,
  returnTo,
  state,
  pending,
  failure,
  onSet,
  onClear,
  nativeFallback = true,
  hideValue = false,
  retryable = false,
}: {
  question: RatingQuestion;
  subjectId: string;
  locale: string;
  returnTo: string;
  state: RatingControlState;
  pending: boolean;
  failure: string | null;
  onSet: (units: number) => void;
  onClear: () => void;
  nativeFallback?: boolean;
  hideValue?: boolean;
  retryable?: boolean;
}) {
  const options = { locale: locale as never };
  const formId = useId();
  const labelId = `${formId}-label`;
  const [draft, setDraft] = useState<number | null>(state.kind === 'ready' ? state.units : null);
  const editing = useRef(false);
  const fallback = nativeFallback ? (
    <NoScriptForm
      question={question}
      subjectId={subjectId}
      returnTo={returnTo}
      locale={locale}
      value={state.kind === 'ready' ? state.units : null}
    />
  ) : null;

  useEffect(() => {
    if (!editing.current && !pending) setDraft(state.kind === 'ready' ? state.units : null);
  }, [pending, state.kind, state.kind === 'ready' ? state.units : null]);

  if (state.kind === 'unavailable')
    return <div aria-hidden="true" className="min-h-12" data-slot="rating-control-reserved" />;

  if (state.kind === 'signed-out')
    return (
      <div className="min-h-12 min-w-0" data-slot="rating-control-reserved">
        <a
          className={`inline-flex items-center text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80 ${actionClassName}`}
          href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}
        >
          {m.account_sign_in({}, options)}
        </a>
        {fallback}
      </div>
    );

  if (state.kind === 'unknown')
    return (
      <div aria-busy="true" className="min-h-12" data-slot="rating-control-reserved">
        {failure !== null && (
          <p className="text-sm" role="status">
            {failure}
          </p>
        )}
        {fallback}
      </div>
    );

  const value = hideValue ? null : draft;
  const scale = question.scale;
  const sliderValue =
    value ?? scale.min + Math.floor((scale.max - scale.min) / scale.displayStep / 2) * scale.displayStep;
  const display = (units: number | null) =>
    units === null
      ? m.subject_rating_control_unrated({}, options)
      : m.subject_rating_control_value(
          { score: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(displayRating(units, scale)) },
          options,
        );
  const valueText = display(value);
  const clearOnKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home' && !pending && event.target instanceof HTMLInputElement && event.target.type === 'range') {
      editing.current = true;
      setDraft(scale.min);
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !pending && state.units !== null) {
      event.preventDefault();
      editing.current = false;
      setDraft(null);
      onClear();
    }
  };

  return (
    <div
      aria-busy={pending}
      className="min-w-0 space-y-2"
      data-slot="rating-control-reserved"
      onKeyDownCapture={clearOnKey}
    >
      <Field.Root
        className="space-y-2"
        render={
          <form
            action={returnTo}
            aria-labelledby={labelId}
            id={formId}
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending || value === null || (value === state.units && !retryable)) return;
              editing.current = false;
              onSet(value);
            }}
          />
        }
      >
        <RatingFormIdentity question={question} subjectId={subjectId} returnTo={returnTo} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Field.Label className="min-w-0 wrap-anywhere font-medium text-sm" id={labelId}>
            {question.label}
          </Field.Label>
          <output aria-live="polite" className="font-semibold tabular-nums" data-slot="rating-control-value">
            {valueText}
          </output>
        </div>
        <Slider.Root
          className="[&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5 **:data-[slot=slider-thumb]:ring-2 **:data-[slot=slider-thumb]:ring-primary"
          data-slot="slider"
          disabled={nativeFallback && pending}
          aria-disabled={pending}
          locale={locale}
          name="units"
          thumbAlignment="edge"
          max={question.scale.max}
          min={question.scale.min}
          onValueChange={(next) => {
            const units = Array.isArray(next) ? next[0] : next;
            if (!pending && typeof units === 'number') {
              editing.current = true;
              setDraft(
                Math.min(
                  scale.max,
                  Math.max(
                    scale.min,
                    scale.min + Math.round((units - scale.min) / scale.displayStep) * scale.displayStep,
                  ),
                ),
              );
            }
          }}
          step={question.scale.displayStep}
          value={[sliderValue]}
        >
          <Slider.Control className="relative flex min-h-11 w-full touch-none items-center select-none data-disabled:opacity-50">
            <Slider.Track
              data-slot="slider-track"
              className="relative h-1 w-full grow overflow-hidden rounded-2xl bg-input/90"
            >
              <Slider.Indicator data-slot="slider-range" className="h-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb
              aria-label={question.label}
              aria-valuetext={valueText}
              data-slot="slider-thumb"
              className="block size-5 shrink-0 rounded-2xl bg-white shadow-md ring-2 ring-primary not-dark:bg-clip-padding transition-[color,box-shadow] duration-200 select-none hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
            />
          </Slider.Control>
        </Slider.Root>
        <div aria-hidden="true" className="flex justify-between text-muted-foreground text-xs tabular-nums">
          <span>{displayRating(scale.min, scale)}</span>
          <span>{displayRating(scale.max, scale)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className={actionClassName}
            disabled={nativeFallback && (pending || value === null || (value === state.units && !retryable))}
            aria-disabled={pending || value === null || (value === state.units && !retryable)}
            onClick={() => {
              editing.current = false;
              if (!pending && value !== null && (value !== state.units || retryable)) onSet(value);
            }}
            type="button"
          >
            {m.subject_rating_control_save({}, options)}
          </Button>
          <Button
            className={actionClassName}
            disabled={nativeFallback && (pending || state.units === null)}
            aria-disabled={pending || state.units === null}
            onClick={() => {
              if (pending || state.units === null) return;
              editing.current = false;
              setDraft(null);
              onClear();
            }}
            type="button"
            variant="outline"
          >
            {m.subject_rating_control_clear({}, options)}
          </Button>
        </div>
        {failure === null ? null : (
          <p className="text-sm" role="status">
            {failure}
          </p>
        )}
      </Field.Root>
      {fallback}
    </div>
  );
}

function RatingFormIdentity({
  question,
  subjectId,
  returnTo,
}: {
  question: RatingQuestion;
  subjectId: string;
  returnTo: string;
}) {
  return (
    <>
      <input name="questionId" type="hidden" value={question.id} />
      <input name="subjectId" type="hidden" value={subjectId} />
      <input name="returnTo" type="hidden" value={returnTo} />
    </>
  );
}

function NoScriptForm({
  question,
  subjectId,
  returnTo,
  locale,
  value,
}: {
  question: RatingQuestion;
  subjectId: string;
  returnTo: string;
  locale: string;
  value: number | null;
}) {
  const options = { locale: locale as never };
  const formId = useId();
  const inputId = `${formId}-units`;
  const labelId = `${formId}-label`;
  return (
    <noscript>
      <form
        action={returnTo}
        aria-labelledby={labelId}
        className="mt-3 flex flex-wrap items-center gap-2"
        id={formId}
        method="post"
      >
        <RatingFormIdentity question={question} subjectId={subjectId} returnTo={returnTo} />
        <label className="min-w-0 wrap-anywhere text-sm" htmlFor={inputId} id={labelId}>
          {question.label}
        </label>
        <input
          aria-label={question.label}
          className="min-h-11 min-w-11 max-w-full"
          defaultValue={
            value ??
            question.scale.min +
              Math.floor((question.scale.max - question.scale.min) / question.scale.displayStep / 2) *
                question.scale.displayStep
          }
          id={inputId}
          max={question.scale.max}
          min={question.scale.min}
          name="units"
          step={question.scale.displayStep}
          type="range"
        />
        <button
          className={`rounded-2xl bg-primary px-3 text-primary-foreground text-sm ${actionClassName}`}
          name="intent"
          type="submit"
          value="save"
        >
          {m.subject_rating_control_save({}, options)}
        </button>
        {value !== null && (
          <button
            className={`rounded-2xl border px-3 text-sm ${actionClassName}`}
            name="intent"
            type="submit"
            value="clear"
          >
            {m.subject_rating_control_clear({}, options)}
          </button>
        )}
      </form>
    </noscript>
  );
}

function boundRatingCommand(
  subjectId: string,
  units: number | null,
  originatingBinding: SubjectPersonalLease,
  question: RatingQuestion,
  idempotencyKey: string,
  expectedCredential: string,
): QuestionBoundRatingInput {
  return Object.freeze({
    subjectId,
    units,
    idempotencyKey,
    expectedReader: originatingBinding.reader,
    expectedCredential,
    question: Object.freeze({
      id: question.id,
      revision: question.revision,
      grain: question.grain,
      meaning: question.meaning ?? question.canonicalLabel ?? question.label,
      scale: Object.freeze({ ...question.scale }),
    }),
  });
}

export function SubjectRatingControl({
  question,
  subjectId,
  locale,
  returnTo,
  session,
  own,
  binding,
  initialFailure = false,
  write,
}: {
  subjectId: string;
  locale: string;
  returnTo: string;
  question: RatingQuestion;
  session: 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';
  own: SubjectOwnRating | undefined;
  binding?: SubjectPersonalLease;
  initialFailure?: boolean;
  write?: RatingWrite;
}) {
  const queryClient = useQueryClient();
  const bindingKey = JSON.stringify([binding?.key ?? `inactive:${subjectId}:${locale}`, question]);
  const sourceRef = useRef(bindingKey);
  sourceRef.current = bindingKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const pendingId = useRef(0);
  const activePending = useRef<{ scope: string; id: number } | null>(null);
  const pendingCommand = useRef<PersonalScoreWriteCommand | null>(null);
  const boundCommand = useRef<QuestionBoundRatingInput | null>(null);
  const [pendingState, setPendingState] = useState<{ scope: string; id: number } | null>(null);
  const [failureState, setFailureState] = useState<{ scope: string; message: string } | null>(null);
  const [retryableState, setRetryableState] = useState<{ scope: string } | null>(null);
  const pending = pendingState?.scope === bindingKey;
  const retryable = retryableState?.scope === bindingKey;
  const failure =
    failureState?.scope === bindingKey
      ? failureState.message
      : initialFailure
        ? m.subject_rating_control_error({}, { locale: locale as never })
        : null;
  const state: RatingControlState =
    session === 'unknown'
      ? { kind: 'unknown' }
      : session === 'unavailable'
        ? { kind: 'unavailable' }
        : session === 'signed-out'
          ? { kind: 'signed-out' }
          : !binding || !binding.isCurrent() || own === undefined || own.reader !== binding.reader
            ? { kind: 'unknown' }
            : own.kind === 'unavailable'
              ? { kind: 'unavailable' }
              : { kind: 'ready', units: own.units };

  const change = async (units: number | null) => {
    const originatingBinding = bindingRef.current;
    if (!originatingBinding) return;
    const scope = bindingKey;
    const isCurrentBinding = () => mounted.current && originatingBinding.isCurrent() && sourceRef.current === scope;
    if (!isCurrentBinding()) return;
    if (activePending.current?.scope === scope) return;
    const command = personalScoreWriteCommand(pendingCommand.current, units);
    pendingCommand.current = command;
    const expectedCredential = queryClient.getQueryData<BrowserSession>(sessionQueryKey)?.csrfToken ?? '';
    const request = boundRatingCommand(
      subjectId,
      units,
      originatingBinding,
      question,
      command.key,
      expectedCredential,
    );
    boundCommand.current = request;
    const id = ++pendingId.current;
    activePending.current = { scope, id };
    setPendingState({ scope, id });
    setFailureState(null);
    try {
      const saved = await applyOptimisticRatingChange({
        queryClient,
        subjectId,
        locale,
        binding: { ...originatingBinding, isCurrent: isCurrentBinding },
        units,
        pendingCommand: command,
        request,
        write:
          write ??
          (() => changeQuestionBoundRating({ data: boundCommand.current ?? request })),
        onFailure: (result) => {
          if (!isCurrentBinding()) return;
          const notice = personalScoreWriteNotice(result.stale ? 'stale' : result.uncertain ? 'uncertain' : 'rejected');
          if (notice === 'uncertain') setRetryableState({ scope });
          else {
            pendingCommand.current = null;
            boundCommand.current = null;
            setRetryableState(null);
          }
          setFailureState({ scope, message: ratingNotice(locale, notice) });
        },
      });
      if (saved) {
        pendingCommand.current = null;
        boundCommand.current = null;
        setRetryableState(null);
      }
    } finally {
      if (isCurrentBinding() && activePending.current?.scope === scope && activePending.current.id === id) {
        activePending.current = null;
        setPendingState(null);
      }
    }
  };

  return (
    <RatingControlView
      key={`${bindingKey}:${question.id}:${question.revision}`}
      question={question}
      failure={failure}
      locale={locale}
      onClear={() => void change(null)}
      onSet={(units) => void change(units)}
      pending={pending}
      retryable={retryable}
      returnTo={returnTo}
      state={state}
      subjectId={subjectId}
    />
  );
}
