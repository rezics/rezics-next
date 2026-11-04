import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { readCalendarDate } from '@rezics/filter';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import {
  calendarDraftRange,
  calendarPrecision,
  type ConditionCalendarDraft,
  type ConditionCalendarRange,
} from './condition-calendar';

type FieldProps = { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string };

/** Raw repair state belongs to the existing occurrence, independently of its executable operand. */
export function ConditionCalendarRangeEditor({
  range,
  property,
  draft,
  locale,
  field,
  onChange,
}: {
  range: ConditionCalendarRange;
  property: string;
  draft: { calendar?: ConditionCalendarDraft };
  locale: string;
  field(bound: 'gte' | 'lte', input: (props: FieldProps) => ReactNode): ReactNode;
  onChange(range: ConditionCalendarRange): void;
}) {
  const committed = () => ({
    lower: range.gte ?? '',
    upper: range.lte ?? '',
    unit: '',
    invalid: !calendarDraftRange(range.gte ?? '', range.lte ?? ''),
  });
  const [state, setState] = useState(() =>
    draft.calendar?.property === property && draft.calendar.value === range
      ? draft.calendar
      : { property, value: range, raw: committed() },
  );
  let current = state;
  if (state.property !== property || state.value !== range) {
    current = { property, value: range, raw: committed() };
    setState(current);
    draft.calendar = current;
  }
  const { lower, upper } = current.raw;
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const helpId = useId();
  const lowerInput = useRef<HTMLInputElement>(null);
  const upperInput = useRef<HTMLInputElement>(null);
  const malformed = (text: string) => text !== '' && !readCalendarDate(text);
  const lowerBad = malformed(lower);
  const upperBad = malformed(upper);
  const rangeError =
    lowerBad || upperBad
      ? undefined
      : lower === '' && upper === ''
        ? m.condition_calendar_empty({}, options)
        : !calendarDraftRange(lower, upper)
          ? m.condition_calendar_reversed({}, options)
          : undefined;
  const lowerError = lowerBad ? m.condition_calendar_invalid({}, options) : rangeError;
  const upperError = upperBad ? m.condition_calendar_invalid({}, options) : rangeError;
  useLayoutEffect(() => {
    lowerInput.current?.setCustomValidity(lowerError ?? '');
    upperInput.current?.setCustomValidity(upperError ?? '');
  }, [lowerError, upperError]);
  const edit = (bound: 'gte' | 'lte', text: string) => {
    const raw = { ...current.raw, [bound === 'gte' ? 'lower' : 'upper']: text };
    const next = calendarDraftRange(raw.lower, raw.upper);
    raw.invalid = !next;
    const changed = { property, value: next ?? range, raw };
    draft.calendar = changed;
    setState(changed);
    if (next) onChange(next);
  };
  return (
    <>
      <p id={helpId} className="text-sm text-muted-foreground">
        {m.condition_calendar_help({}, options)}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {(['gte', 'lte'] as const).map((bound) =>
          field(bound, (props) => {
            const raw = bound === 'gte' ? lower : upper;
            const error = bound === 'gte' ? lowerError : upperError;
            const statusId = `${props.id}-precision`;
            const errorId = `${props.id}-draft-error`;
            return (
              <>
                <Input
                  {...props}
                  ref={bound === 'gte' ? lowerInput : upperInput}
                  type="text"
                  maxLength={23}
                  placeholder="2024-02"
                  value={raw}
                  aria-invalid={props['aria-invalid'] || !!error}
                  aria-describedby={[props['aria-describedby'], helpId, statusId, error ? errorId : undefined]
                    .filter(Boolean)
                    .join(' ')}
                  onChange={(event) => edit(bound, event.currentTarget.value)}
                />
                <p id={statusId} className="text-sm text-muted-foreground" aria-live="polite">
                  {calendarPrecision(raw, locale)}
                </p>
                {error && (
                  <p id={errorId} className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </>
            );
          }),
        )}
      </div>
      <p className="text-sm text-muted-foreground">{m.condition_calendar_overlap({}, options)}</p>
    </>
  );
}
