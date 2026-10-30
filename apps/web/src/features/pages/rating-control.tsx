import { Button } from '@rezics/ui/shadcn/button';
import { Slider } from '@rezics/ui/shadcn/slider';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { changeSubjectRating } from './rating-actions';
import { subjectOwnRatingQuery, subjectRatingQuery } from './subject-queries';
import type { SubjectOwnRating } from './subject-ratings';

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
  subjectId,
  locale,
  returnTo,
  state,
  pending,
  failure,
  onSet,
  onClear,
}: {
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
        <NoScriptForm returnTo={returnTo} locale={locale} value={null} />
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
        <NoScriptForm returnTo={returnTo} locale={locale} value={null} />
      </div>
    );

  const value = draft;
  const sliderValue = value ?? 10;
  const display = (units: number | null) =>
    units === null
      ? m.subject_rating_control_unrated({}, options)
      : m.subject_rating_control_value(
          { score: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(units / 2) },
          options,
        );
  const valueText = display(value);
  const clearOnKey = (event: KeyboardEvent<HTMLDivElement>) => {
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
        <label className="font-medium text-sm" htmlFor={`rating-${subjectId}`}>
          {m.subject_rating_control_label({}, options)}
        </label>
        <output
          aria-live="polite"
          className="font-semibold tabular-nums"
          data-slot="rating-control-value"
          htmlFor={`rating-${subjectId}`}
        >
          {valueText}
        </output>
      </div>
      <Slider
        aria-label={m.subject_rating_control_label({}, options)}
        aria-valuetext={valueText}
        className="[&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5 **:data-[slot=slider-thumb]:ring-2 **:data-[slot=slider-thumb]:ring-primary"
        disabled={pending}
        id={`rating-${subjectId}`}
        max={20}
        min={0}
        onValueChange={(next) => {
          const units = Array.isArray(next) ? next[0] : next;
          if (typeof units === 'number') {
            editing.current = true;
            setDraft(Math.min(20, Math.max(0, Math.round(units))));
          }
        }}
        step={1}
        value={[sliderValue]}
      />
      <div aria-hidden="true" className="flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>0</span>
        <span>10</span>
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
      <NoScriptForm returnTo={returnTo} locale={locale} value={state.units} />
    </div>
  );
}

function NoScriptForm({ returnTo, locale, value }: { returnTo: string; locale: string; value: number | null }) {
  const options = { locale: locale as never };
  return (
    <noscript>
      <form action={returnTo} className="mt-3 flex flex-wrap items-center gap-2" method="post">
        <label className="text-sm" htmlFor="rating-no-script">
          {m.subject_rating_control_label({}, options)}
        </label>
        <input
          aria-label={m.subject_rating_control_label({}, options)}
          defaultValue={value ?? 10}
          id="rating-no-script"
          max={20}
          min={0}
          name="units"
          step={1}
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
