import { useMemo, useState } from 'react';
import { de, enUS, es, fr, ja, ko, zhCN, zhTW } from 'date-fns/locale';
import { Calendar } from '@rezics/ui/shadcn/calendar';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Popover, PopoverContent, PopoverTrigger } from '@rezics/ui/shadcn/popover';
import { isCalendarDate } from '@rezics/filter';
import { getLocale } from '../paraglide/runtime.js';

const inputClass =
  'min-h-11 min-w-0 w-full max-w-full rounded-lg border border-border bg-background px-3 text-left text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
const locales = {
  en: enUS,
  de,
  es,
  fr,
  ja,
  ko,
  'zh-Hans': zhCN,
  'zh-Hant': zhTW,
} as const;

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
  const locale = getLocale();
  const selected = calendarDayDate(value);
  const month = selected ?? new Date();
  const dayLocale = locales[locale as keyof typeof locales] ?? enUS;
  const labels = useMemo(
    () => ({
      labelGrid: (date: Date) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date),
      labelDayButton: (date: Date, modifiers: { selected?: boolean }) => {
        const name = new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(date);
        return modifiers.selected ? `${name}, selected` : name;
      },
    }),
    [locale],
  );
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
        <PopoverTrigger
          disabled={disabled}
          render={
            <button
              type="button"
              id={id}
              className={inputClass}
              aria-label={label}
              aria-describedby={describedBy}
              aria-expanded={open}
              aria-haspopup="dialog"
              disabled={disabled}
            />
          }
        >
          {displayDay(value, locale)}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-2" role="dialog" aria-label={label}>
          <Calendar
            mode="single"
            required={required}
            locale={dayLocale}
            labels={labels}
            defaultMonth={month}
            selected={selected}
            disabled={(date) => {
              const day = calendarDayText(date);
              return (!!min && day < min) || (!!max && day > max);
            }}
            onSelect={(date) => {
              if (!date && required) return;
              onChange(date ? calendarDayText(date) : '');
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}
