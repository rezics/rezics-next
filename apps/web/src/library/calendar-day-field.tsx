import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Popover, PopoverContent, PopoverTrigger } from '@rezics/ui/shadcn/popover';
import { isCalendarDate } from '@rezics/filter';
import { getLocale } from '../paraglide/runtime.js';

const inputClass =
  'min-h-11 min-w-0 w-full max-w-full rounded-lg border border-border bg-background px-3 text-left text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
const navClass =
  'inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40';
const dayClass =
  'inline-flex size-11 items-center justify-center rounded-md text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40';

/** Local calendar components, never an instant, so YYYY-MM-DD is not shifted by the browser zone. */
export function calendarDayDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || !isCalendarDate({ year, month, day })) return;
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

export function calendarDayText(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function displayDay(value: string, locale: string): string {
  return calendarDayDate(value)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
    : '\u2014';
}

function addMonths(date: Date, delta: number): Date {
  const next = new Date(2000, 0, 1);
  next.setFullYear(date.getFullYear(), date.getMonth() + delta, 1);
  return next;
}

function monthStart(date: Date): Date {
  const start = new Date(2000, 0, 1);
  start.setFullYear(date.getFullYear(), date.getMonth(), 1);
  return start;
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(2000, 0, 1);
  next.setFullYear(date.getFullYear(), date.getMonth(), date.getDate() + delta);
  return next;
}

function daysInMonth(date: Date): number {
  const next = addMonths(date, 1);
  next.setDate(0);
  return next.getDate();
}

function boundary(value: string | undefined): string | undefined {
  return value && calendarDayDate(value) ? value : undefined;
}

function clampDay(value: string, min?: string, max?: string): string | undefined {
  if (!calendarDayDate(value)) return;
  const lower = boundary(min);
  const upper = boundary(max);
  if (lower && upper && lower > upper) return;
  if (lower && value < lower) return lower;
  if (upper && value > upper) return upper;
  return value;
}

function initialDay(selected: Date | undefined, min?: string, max?: string): string {
  const candidate = selected ? calendarDayText(selected) : calendarDayText(new Date());
  return clampDay(candidate, min, max) ?? candidate;
}

function monthTarget(current: Date, delta: number, min?: string, max?: string): Date | undefined {
  const month = addMonths(current, delta);
  if (month.getFullYear() < 1 || month.getFullYear() > 9999) return;
  const candidate = new Date(2000, 0, 1);
  candidate.setFullYear(month.getFullYear(), month.getMonth(), Math.min(current.getDate(), daysInMonth(month)));
  const target = clampDay(calendarDayText(candidate), min, max);
  if (!target || target === calendarDayText(current)) return;
  return calendarDayDate(target);
}

function weekStart(locale: string): number {
  try {
    const first = (new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay?: number } }).weekInfo?.firstDay;
    if (first === 7) return 0;
    if (typeof first === 'number' && first >= 1 && first <= 6) return first;
  } catch {
    /* Intl.Locale.weekInfo is optional. */
  }
  return 0;
}

function weekdayNames(locale: string, start: number) {
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2024, 0, 7 + ((index + start) % 7));
    return { long: long.format(date), short: short.format(date) };
  });
}

function monthDays(month: Date, start: number): Date[] {
  const first = new Date(2000, 0, 1);
  first.setFullYear(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - start + 7) % 7;
  first.setDate(1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(2000, 0, 1);
    date.setFullYear(first.getFullYear(), first.getMonth(), first.getDate() + index);
    return date;
  });
}

function DayGrid({
  locale,
  selected,
  min,
  max,
  required,
  onSelect,
}: {
  locale: string;
  selected: Date | undefined;
  min?: string | undefined;
  max?: string | undefined;
  required: boolean;
  onSelect: (value: string) => void;
}) {
  const [visit, setVisit] = useState(() => {
    const focusDay = initialDay(selected, min, max);
    const focusDate = calendarDayDate(focusDay) ?? new Date();
    return { focusDay, visible: monthStart(focusDate) };
  });
  const activeDayButton = useRef<HTMLButtonElement>(null);
  const focusDate = calendarDayDate(visit.focusDay) ?? new Date();
  const visible = visit.visible;
  const start = weekStart(locale);
  const names = useMemo(() => weekdayNames(locale, start), [locale, start]);
  const caption = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(visible);
  const days = monthDays(visible, start);
  const selectedText = selected ? calendarDayText(selected) : '';
  const previousTarget = monthTarget(focusDate, -1, min, max);
  const nextTarget = monthTarget(focusDate, 1, min, max);

  const focusDay = (target: Date) => {
    const value = clampDay(calendarDayText(target), min, max);
    if (!value) return;
    const date = calendarDayDate(value);
    if (!date) return;
    setVisit({ focusDay: value, visible: monthStart(date) });
  };

  useLayoutEffect(() => {
    activeDayButton.current?.focus();
  }, [visit.focusDay]);

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    let target: Date | undefined;
    switch (event.key) {
      case 'ArrowLeft':
        target = addDays(date, -1);
        break;
      case 'ArrowRight':
        target = addDays(date, 1);
        break;
      case 'ArrowUp':
        target = addDays(date, -7);
        break;
      case 'ArrowDown':
        target = addDays(date, 7);
        break;
      case 'Home': {
        const offset = (date.getDay() - start + 7) % 7;
        target = addDays(date, -offset);
        break;
      }
      case 'End': {
        const offset = (date.getDay() - start + 7) % 7;
        target = addDays(date, 6 - offset);
        break;
      }
      case 'PageUp':
        target = monthTarget(date, -1, min, max);
        break;
      case 'PageDown':
        target = monthTarget(date, 1, min, max);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target) focusDay(target);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={navClass}
          disabled={!previousTarget}
          aria-label={addMonths(visible, -1).toLocaleString(locale, { month: 'long', year: 'numeric' })}
          onClick={() => previousTarget && focusDay(previousTarget)}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-5" />
        </button>
        <p aria-live="polite" aria-atomic="true" className="min-w-0 text-center font-medium">
          {caption}
        </p>
        <button
          type="button"
          className={navClass}
          disabled={!nextTarget}
          aria-label={addMonths(visible, 1).toLocaleString(locale, { month: 'long', year: 'numeric' })}
          onClick={() => nextTarget && focusDay(nextTarget)}
        >
          <ChevronRightIcon aria-hidden="true" className="size-5" />
        </button>
      </div>
      <table role="grid" aria-label={caption} className="border-collapse">
        <thead>
          <tr>
            {names.map((name) => (
              <th key={name.long} scope="col" className="p-0 text-center text-xs font-medium text-muted-foreground">
                <span className="sr-only">{name.long}</span>
                <span aria-hidden="true">{name.short}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, week) => (
            <tr key={week} role="row">
              {days.slice(week * 7, week * 7 + 7).map((date) => {
                const day = calendarDayText(date);
                const outside = date.getMonth() !== visible.getMonth();
                const pressed = day === selectedText;
                const blocked = clampDay(day, min, max) !== day;
                return (
                  <td key={day} role="gridcell" className="p-0">
                    <button
                      ref={day === visit.focusDay ? activeDayButton : undefined}
                      type="button"
                      className={`${dayClass} ${pressed ? 'bg-primary text-primary-foreground' : outside ? 'text-muted-foreground' : ''} ${blocked ? '' : 'hover:bg-muted'}`}
                      aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(date)}
                      aria-pressed={pressed}
                      tabIndex={day === visit.focusDay && !blocked ? 0 : -1}
                      disabled={blocked}
                      onFocus={() => {
                        if (day !== visit.focusDay) focusDay(date);
                      }}
                      onKeyDown={(event) => handleDayKeyDown(event, date)}
                      onClick={() => {
                        if (pressed && !required) onSelect('');
                        else onSelect(day);
                      }}
                    >
                      {date.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CalendarDayField({
  id,
  name,
  label,
  value,
  describedBy,
  disabled = false,
  required = false,
  min,
  max,
  onChange,
}: {
  id: string;
  name?: string | undefined;
  label: string;
  value: string;
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  min?: string | undefined;
  max?: string | undefined;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open && !disabled;
  const locale = getLocale();
  const selected = calendarDayDate(value);
  useLayoutEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <Popover
        open={isOpen}
        onOpenChange={(next) => {
          if (next && !disabled) setOpen(true);
          else setOpen(false);
        }}
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            <button
              type="button"
              id={id}
              className={inputClass}
              aria-label={label}
              aria-describedby={describedBy}
              aria-expanded={isOpen}
              aria-haspopup="dialog"
              disabled={disabled}
            />
          }
        >
          {displayDay(value, locale)}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-2" role="dialog" aria-label={label}>
          {isOpen ? (
            <DayGrid
              locale={locale}
              selected={selected}
              min={min}
              max={max}
              required={required}
              onSelect={(next) => {
                if (disabled) return;
                onChange(next);
                setOpen(false);
              }}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
