import { Button } from '@rezics/ui/shadcn/button';
import { Slider } from '@base-ui/react/slider';
import { Field } from '@base-ui/react/field';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import type { QuestionBoundRatingInput } from './rating-actions';
import { sessionQueryKey, type BrowserSession } from '../../session';
import {
  personalScoreWriteCommand,
  personalScoreWriteNotice,
  type PersonalScoreWriteCommand,
  type PersonalScoreWriteResult,
} from '../../library/score-write';
import { subjectOwnRatingQuery, subjectRatingQuery } from './subject-queries';
import { type RatingQuestion, type SubjectOwnRating } from './subject-ratings';
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
  const request = input.request ?? {
    units,
    idempotencyKey: personalScoreWriteCommand(input.pendingCommand ?? null, units).key,
    expectedReader: binding.reader,
  };

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
  preserveDraft = false,
  hideQuestionLabel = false,
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
  preserveDraft?: boolean;
  hideQuestionLabel?: boolean;
}) {
  const options = { locale: locale as never };
  const formId = useId();
  const labelId = `${formId}-label`;
  const scaleId = `${formId}-scale`;
  const [draft, setDraft] = useState<number | null>(state.kind === 'ready' ? state.units : null);
  const editing = useRef(false);
  const fallback = nativeFallback ? (
    <NoScriptForm
      question={question}
      subjectId={subjectId}
      returnTo={returnTo}
      locale={locale}
      value={state.kind === 'ready' ? state.units : null}
      hideQuestionLabel={hideQuestionLabel}
    />
  ) : null;

  useEffect(() => {
    if (!editing.current && !pending && !preserveDraft) setDraft(state.kind === 'ready' ? state.units : null);
  }, [pending, preserveDraft, state.kind, state.kind === 'ready' ? state.units : null]);

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
  const number = (units: number) => new Intl.NumberFormat(locale).format(units);
  const display = (units: number | null) =>
    units === null ? m.subject_rating_control_unrated({}, options) : `${number(units)} / ${number(scale.max)}`;
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
              if (pending || value === null || value === state.units) return;
              editing.current = false;
              onSet(value);
            }}
          />
        }
      >
        <RatingFormIdentity question={question} subjectId={subjectId} returnTo={returnTo} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Field.Label
            className={hideQuestionLabel ? 'sr-only' : 'min-w-0 wrap-anywhere font-medium text-sm'}
            id={labelId}
          >
            {question.label}
          </Field.Label>
          <output
            aria-live="polite"
            className={`font-semibold tabular-nums ${hideQuestionLabel ? 'text-2xl' : ''}`}
            data-slot="rating-control-value"
          >
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
              aria-describedby={scaleId}
              data-slot="slider-thumb"
              className="block size-5 shrink-0 rounded-2xl bg-white shadow-md ring-2 ring-primary not-dark:bg-clip-padding transition-[color,box-shadow] duration-200 select-none hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
            />
          </Slider.Control>
        </Slider.Root>
        <p id={scaleId} className="text-xs text-muted-foreground tabular-nums">
          {m.rating_native_scale(
            { min: number(scale.min), max: number(scale.max), step: number(scale.displayStep) },
            options,
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            className={actionClassName}
            disabled={nativeFallback && (pending || value === null || value === state.units)}
            aria-disabled={pending || value === null || value === state.units}
            onClick={() => {
              editing.current = false;
              if (!pending && value !== null && value !== state.units) onSet(value);
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

export type RatingAnswerRecovery =
  | { kind: 'idle' | 'loading' | 'unavailable' }
  | { kind: 'ready'; units: number | null };

/** An answer observation is useful independently of the original command's delivery result. */
export function RatingRecoveryView({
  original,
  currentScale,
  locale,
  pending,
  reading,
  onRetry,
  onRead,
}: {
  original: Pick<QuestionBoundRatingInput, 'units' | 'question'>;
  currentScale: RatingQuestion['scale'];
  locale: string;
  pending: boolean;
  reading: RatingAnswerRecovery;
  onRetry: () => void;
  onRead: () => void;
}) {
  const options = { locale: locale as never };
  const number = (units: number) => new Intl.NumberFormat(locale).format(units);
  const busy = pending || reading.kind === 'loading';
  return (
    <div className="min-w-0 space-y-2" data-slot="rating-recovery" aria-busy={busy}>
      <p className="text-sm" role="status">
        {m.subject_rating_control_uncertain({}, options)}
      </p>
      <p className="text-sm font-medium wrap-anywhere" data-slot="rating-original-request">
        {original.units === null
          ? m.subject_rating_control_original_clear({}, options)
          : m.subject_rating_control_original_save(
              { score: number(original.units), max: number(original.question.scale.max) },
              options,
            )}
      </p>
      <p className="text-xs text-muted-foreground wrap-anywhere">{original.question.meaning}</p>
      <div className="flex flex-wrap gap-2">
        <Button className={actionClassName} disabled={busy} onClick={onRetry} type="button">
          {original.units === null
            ? m.subject_rating_control_retry_clear({}, options)
            : m.subject_rating_control_retry_save({}, options)}
        </Button>
        <Button className={actionClassName} disabled={busy} onClick={onRead} type="button" variant="outline">
          {m.subject_rating_control_read_current({}, options)}
        </Button>
      </div>
      <div aria-live="polite" className="text-sm" data-slot="rating-current-answer">
        {reading.kind === 'loading' && m.subject_rating_control_reading({}, options)}
        {reading.kind === 'unavailable' && m.subject_rating_control_read_failed({}, options)}
        {reading.kind === 'ready' && (
          <>
            <p>
              {reading.units === null
                ? m.subject_rating_control_current_clear({}, options)
                : m.subject_rating_control_current_save(
                    { score: number(reading.units), max: number(currentScale.max) },
                    options,
                  )}
            </p>
            <p className="text-muted-foreground">{m.subject_rating_control_read_separate({}, options)}</p>
          </>
        )}
      </div>
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
  hideQuestionLabel,
}: {
  question: RatingQuestion;
  subjectId: string;
  returnTo: string;
  locale: string;
  value: number | null;
  hideQuestionLabel: boolean;
}) {
  const options = { locale: locale as never };
  const formId = useId();
  const inputId = `${formId}-units`;
  const labelId = `${formId}-label`;
  const scaleId = `${formId}-scale`;
  const number = (units: number) => new Intl.NumberFormat(locale).format(units);
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
        <label
          className={hideQuestionLabel ? 'sr-only' : 'min-w-0 wrap-anywhere text-sm'}
          htmlFor={inputId}
          id={labelId}
        >
          {question.label}
        </label>
        <input
          aria-label={question.label}
          aria-describedby={scaleId}
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
        <p id={scaleId} className="basis-full text-xs text-muted-foreground">
          {m.rating_native_scale(
            {
              min: number(question.scale.min),
              max: number(question.scale.max),
              step: number(question.scale.displayStep),
            },
            options,
          )}
        </p>
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

type PendingRatingCommand = Readonly<{
  request: QuestionBoundRatingInput;
  sender: RatingWrite;
  binding: SubjectPersonalLease;
}>;

type SubjectRatingControlProps = {
  subjectId: string;
  locale: string;
  returnTo: string;
  question: RatingQuestion;
  session: 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';
  own: SubjectOwnRating | undefined;
  binding?: SubjectPersonalLease;
  initialFailure?: boolean;
  hideQuestionLabel?: boolean;
  write?: RatingWrite;
};

export function SubjectRatingControl(props: SubjectRatingControlProps) {
  // Question and answer observations can change within a reader's lifetime. Only that lifetime owns private intent.
  const owner = useRef({ binding: props.binding, incarnation: 0 });
  if (owner.current.binding !== props.binding)
    owner.current = { binding: props.binding, incarnation: owner.current.incarnation + 1 };
  const lifetime = JSON.stringify([
    props.binding?.key,
    owner.current.incarnation,
    props.subjectId,
    props.locale,
    props.session,
  ]);
  return <MountedSubjectRatingControl key={lifetime} {...props} />;
}

function MountedSubjectRatingControl({
  question,
  subjectId,
  locale,
  returnTo,
  session,
  own,
  binding,
  initialFailure = false,
  hideQuestionLabel = false,
  write,
}: SubjectRatingControlProps) {
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  const pendingCommand = useRef<PendingRatingCommand | null>(null);
  const activePending = useRef<object | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingCommand.current = null;
      activePending.current = null;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(
    initialFailure ? m.subject_rating_control_error({}, { locale: locale as never }) : null,
  );
  const [retryable, setRetryable] = useState(false);
  const [reading, setReading] = useState<RatingAnswerRecovery>({ kind: 'idle' });
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

  const change = (units: number | null) => {
    if (!binding?.isCurrent() || !mounted.current || activePending.current) return;
    const command = personalScoreWriteCommand(null, units);
    const expectedCredential = queryClient.getQueryData<BrowserSession>(sessionQueryKey)?.csrfToken ?? '';
    const request = boundRatingCommand(subjectId, units, binding, question, command.key, expectedCredential);
    // Capture the sender as well as the envelope: neither lazy loading nor later props may replace this request.
    const sender: RatingWrite =
      write ??
      (async () => {
        const { changeQuestionBoundRating } = await import('./rating-actions');
        if (!mounted.current || !binding.isCurrent()) return 'rejected';
        return changeQuestionBoundRating({ data: request });
      });
    const original = Object.freeze({ request, sender, binding });
    pendingCommand.current = original;
    setRetryable(false);
    setReading({ kind: 'idle' });
    void dispatch(original);
  };

  const dispatch = async (original: PendingRatingCommand) => {
    if (
      !mounted.current ||
      !original.binding.isCurrent() ||
      activePending.current ||
      pendingCommand.current !== original
    )
      return;
    const attempt = {};
    const isCurrent = () =>
      mounted.current &&
      original.binding.isCurrent() &&
      pendingCommand.current === original &&
      activePending.current === attempt;
    activePending.current = attempt;
    setPending(true);
    setFailure(null);
    try {
      const saved = await applyOptimisticRatingChange({
        queryClient,
        subjectId: original.request.subjectId,
        locale,
        binding: { ...original.binding, isCurrent },
        units: original.request.units,
        request: original.request,
        write: original.sender,
        onFailure: (result) => {
          if (!isCurrent()) return;
          const notice = personalScoreWriteNotice(result.stale ? 'stale' : result.uncertain ? 'uncertain' : 'rejected');
          setRetryable(notice === 'uncertain');
          if (notice !== 'uncertain') pendingCommand.current = null;
          setFailure(ratingNotice(locale, notice));
        },
      });
      if (saved && isCurrent()) {
        pendingCommand.current = null;
        setRetryable(false);
      }
    } finally {
      if (mounted.current && original.binding.isCurrent() && activePending.current === attempt) {
        activePending.current = null;
        setPending(false);
      }
    }
  };

  const readCurrentAnswer = async (original: PendingRatingCommand) => {
    if (
      !mounted.current ||
      !original.binding.isCurrent() ||
      activePending.current ||
      pendingCommand.current !== original
    )
      return;
    const attempt = {};
    activePending.current = attempt;
    const isCurrent = () =>
      mounted.current &&
      original.binding.isCurrent() &&
      pendingCommand.current === original &&
      activePending.current === attempt;
    setReading({ kind: 'loading' });
    try {
      const result = await queryClient.fetchQuery(
        subjectOwnRatingQuery(original.request.subjectId, locale, original.binding.scope),
      );
      if (!isCurrent()) return;
      setReading(result.kind === 'ready' ? { kind: 'ready', units: result.units } : { kind: 'unavailable' });
    } catch {
      if (isCurrent()) setReading({ kind: 'unavailable' });
    } finally {
      if (mounted.current && original.binding.isCurrent() && activePending.current === attempt)
        activePending.current = null;
    }
  };

  const original = retryable ? pendingCommand.current : null;
  return (
    <div className="min-w-0 space-y-3">
      <RatingControlView
        question={question}
        hideQuestionLabel={hideQuestionLabel}
        failure={original ? null : failure}
        locale={locale}
        onClear={() => change(null)}
        onSet={change}
        pending={pending || reading.kind === 'loading'}
        preserveDraft={retryable}
        returnTo={returnTo}
        state={state}
        subjectId={subjectId}
      />
      {original && (
        <RatingRecoveryView
          original={original.request}
          currentScale={question.scale}
          locale={locale}
          pending={pending}
          reading={reading}
          onRetry={() => void dispatch(original)}
          onRead={() => void readCurrentAnswer(original)}
        />
      )}
    </div>
  );
}
