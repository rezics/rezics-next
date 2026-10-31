import { Button } from '@rezics/ui/shadcn/button';
import { Slider } from '@base-ui/react/slider';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { changeSubjectRating } from './rating-actions';
import { subjectOwnRatingQuery, subjectRatingQuery } from './subject-queries';
import { displayRating, type RatingQuestion, type SubjectOwnRating } from './subject-ratings';

export type RatingControlState =
  | { kind: 'unknown' }
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; units: number | null };

type RatingWrite = (input: { units: number | null; idempotencyKey: string }) => Promise<boolean>;

export async function applyOptimisticRatingChange(input: {
  queryClient: ReturnType<typeof useQueryClient>;
  subjectId: string;
  locale: string;
  units: number | null;
  write: RatingWrite;
  onFailure: () => void;
}): Promise<boolean> {
  const { queryClient, subjectId, locale, units, write, onFailure } = input;
  const ownQueryOptions = subjectOwnRatingQuery(subjectId, locale);
  const ownKey = ownQueryOptions.queryKey;
  const ownQuery = queryClient.getQueryCache().build(queryClient, ownQueryOptions);
  const before = ownQuery.state.data;
  void queryClient.cancelQueries({ queryKey: ownKey });
  ownQuery.setData({ kind: 'ready', units });

  let saved = false;
  try {
    saved = await write({ units, idempotencyKey: crypto.randomUUID() });
  } catch {
    saved = false;
  }
  if (!saved) {
    if (before === undefined) queryClient.removeQueries({ queryKey: ownKey, exact: true });
    else ownQuery.setData(before);
    onFailure();
    return false;
  }

  // Public figures publish asynchronously; refresh them in the background after the vote succeeds.
  void queryClient.invalidateQueries({ queryKey: subjectRatingQuery(subjectId, locale).queryKey }).catch(() => {});
  return true;
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
}) {
  const options = { locale: locale as never };
  const [draft, setDraft] = useState<number | null>(state.kind === 'ready' ? state.units : null);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current && !pending) setDraft(state.kind === 'ready' ? state.units : null);
  }, [pending, state.kind, state.kind === 'ready' ? state.units : null]);

  if (state.kind === 'unavailable')
    return <div aria-hidden="true" className="min-h-12" data-slot="rating-control-reserved" />;

  if (state.kind === 'signed-out')
    return (
      <div className="min-h-12" data-slot="rating-control-reserved">
        <a
          className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}
        >
          {m.account_sign_in({}, options)}
        </a>
        <NoScriptForm question={question} returnTo={returnTo} locale={locale} value={null} />
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
        <NoScriptForm question={question} returnTo={returnTo} locale={locale} value={null} />
      </div>
    );

  const value = draft;
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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-medium text-sm">{question.label}</span>
        <output aria-live="polite" className="font-semibold tabular-nums" data-slot="rating-control-value">
          {valueText}
        </output>
      </div>
      <Slider.Root
        className="[&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5 **:data-[slot=slider-thumb]:ring-2 **:data-[slot=slider-thumb]:ring-primary"
        data-slot="slider"
        disabled={pending}
        locale={locale}
        thumbAlignment="edge"
        max={question.scale.max}
        min={question.scale.min}
        onValueChange={(next) => {
          const units = Array.isArray(next) ? next[0] : next;
          if (typeof units === 'number') {
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
            className="block size-5 shrink-0 rounded-2xl bg-white shadow-md ring-2 ring-primary transition-[color,box-shadow] duration-200 select-none hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          />
        </Slider.Control>
      </Slider.Root>
      <div aria-hidden="true" className="flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>{displayRating(scale.min, scale)}</span>
        <span>{displayRating(scale.max, scale)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || value === null || value === state.units}
          onClick={() => {
            editing.current = false;
            if (value !== null) onSet(value);
          }}
          type="button"
        >
          {m.subject_rating_control_save({}, options)}
        </Button>
        <Button
          disabled={pending || state.units === null}
          onClick={() => {
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
      <NoScriptForm question={question} returnTo={returnTo} locale={locale} value={state.units} />
    </div>
  );
}

function NoScriptForm({
  question,
  returnTo,
  locale,
  value,
}: {
  question: RatingQuestion;
  returnTo: string;
  locale: string;
  value: number | null;
}) {
  const options = { locale: locale as never };
  return (
    <noscript>
      <form action={returnTo} className="mt-3 flex flex-wrap items-center gap-2" method="post">
        <label className="text-sm" htmlFor="rating-no-script">
          {question.label}
        </label>
        <input
          aria-label={question.label}
          defaultValue={
            value ??
            question.scale.min +
              Math.floor((question.scale.max - question.scale.min) / question.scale.displayStep / 2) *
                question.scale.displayStep
          }
          id="rating-no-script"
          max={question.scale.max}
          min={question.scale.min}
          name="units"
          step={question.scale.displayStep}
          type="range"
        />
        <button
          className="rounded-2xl bg-primary px-3 py-1.5 text-primary-foreground text-sm"
          name="intent"
          type="submit"
          value="save"
        >
          {m.subject_rating_control_save({}, options)}
        </button>
        {value !== null && (
          <button className="rounded-2xl border px-3 py-1.5 text-sm" name="intent" type="submit" value="clear">
            {m.subject_rating_control_clear({}, options)}
          </button>
        )}
      </form>
    </noscript>
  );
}

export function SubjectRatingControl({
  question,
  subjectId,
  locale,
  returnTo,
  session,
  own,
  initialFailure = false,
}: {
  subjectId: string;
  locale: string;
  returnTo: string;
  question: RatingQuestion;
  session: 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';
  own: SubjectOwnRating | undefined;
  initialFailure?: boolean;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(
    initialFailure ? m.subject_rating_control_error({}, { locale: locale as never }) : null,
  );
  const state: RatingControlState =
    session === 'unknown'
      ? { kind: 'unknown' }
      : session === 'unavailable'
        ? { kind: 'unavailable' }
        : session === 'signed-out'
          ? { kind: 'signed-out' }
          : own === undefined
            ? { kind: 'unknown' }
            : own.kind === 'unavailable'
              ? { kind: 'unavailable' }
              : { kind: 'ready', units: own.units };

  const change = async (units: number | null) => {
    setPending(true);
    setFailure(null);
    await applyOptimisticRatingChange({
      queryClient,
      subjectId,
      locale,
      units,
      write: async ({ idempotencyKey }) => changeSubjectRating({ data: { subjectId, units, idempotencyKey } }),
      onFailure: () => setFailure(m.subject_rating_control_error({}, { locale: locale as never })),
    });
    setPending(false);
  };

  return (
    <RatingControlView
      key={`${question.id}:${question.revision}`}
      question={question}
      failure={failure}
      locale={locale}
      onClear={() => void change(null)}
      onSet={(units) => void change(units)}
      pending={pending}
      returnTo={returnTo}
      state={state}
      subjectId={subjectId}
    />
  );
}
