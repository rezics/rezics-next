import { calendarRangeBounds, readCalendarDate, type FilterRange } from '@rezics/filter';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import type { RangeDraft } from './refinement/range-draft';

export type ConditionCalendarRange = Extract<FilterRange, { type: 'time' }>;
export type ConditionCalendarDraft = {
  property: string;
  value: ConditionCalendarRange;
  raw: RangeDraft;
};

/** Empty text is an open endpoint only when the other endpoint forms a valid range. */
export function calendarDraftRange(lower: string, upper: string): ConditionCalendarRange | undefined {
  const range: ConditionCalendarRange = {
    type: 'time',
    ...(lower === '' ? {} : { gte: lower }),
    ...(upper === '' ? {} : { lte: upper }),
  };
  return calendarRangeBounds(range) ? range : undefined;
}

export function calendarPrecision(raw: string | undefined, locale: string): string {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  if (!raw) return m.condition_calendar_open({}, options);
  const date = readCalendarDate(raw);
  if (!date) return m.condition_calendar_incomplete({}, options);
  return date.day !== undefined
    ? m.condition_calendar_day({}, options)
    : date.month !== undefined
      ? m.condition_calendar_month({}, options)
      : m.condition_calendar_year({}, options);
}
