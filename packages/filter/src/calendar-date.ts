/** A Gregorian date at its represented precision, using astronomical year numbering. */
export type CalendarDate = { year: number; month?: number; day?: number };
export type CalendarInterval = { lower: string; upper: string };
export type CalendarRange = { gte?: string; lte?: string };

const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const YEAR_BIAS = 10_000_000_000_000_000n;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** A missing component is precision, never an implicit January or first day. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (!object(value) || typeof value.year !== 'number' || !Number.isSafeInteger(value.year)) return false;
  if (value.month === undefined) return value.day === undefined;
  if (typeof value.month !== 'number' || !Number.isInteger(value.month) || value.month < 1 || value.month > 12)
    return false;
  return (
    value.day === undefined ||
    (typeof value.day === 'number' &&
      Number.isInteger(value.day) &&
      value.day >= 1 &&
      value.day <= daysInMonth(value.year, value.month))
  );
}

/** Portable Semantic time content. Unsupported or incomplete evidence has no date projection. */
export function readNativeCalendarDate(content: unknown): CalendarDate | undefined {
  if (!object(content) || content.calendarmodel !== GREGORIAN || typeof content.time !== 'string') return;
  const match = /^([+-][0-9]{4,})-([0-9]{2})-([0-9]{2})T00:00:00Z$/.exec(content.time);
  if (!match) return;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let date: CalendarDate;
  if (content.precision === 9 && month === 0 && day === 0) date = { year };
  else if (content.precision === 10 && day === 0) date = { year, month };
  else if (content.precision === 11 && month !== 0 && day !== 0) date = { year, month, day };
  else return;
  return isCalendarDate(date) ? date : undefined;
}

/** User endpoints: YYYY, YYYY-MM or YYYY-MM-DD; signed extended years are supported. */
export function readCalendarDate(value: unknown): CalendarDate | undefined {
  if (typeof value !== 'string') return;
  // A safe integer year has at most 16 digits; bound input before converting it.
  const match = /^([+-]?[0-9]{4,16})(?:-([0-9]{2})(?:-([0-9]{2}))?)?$/.exec(value);
  if (!match) return;
  const date: CalendarDate = {
    year: Number(match[1]),
    ...(match[2] === undefined ? {} : { month: Number(match[2]) }),
    ...(match[3] === undefined ? {} : { day: Number(match[3]) }),
  };
  return isCalendarDate(date) ? date : undefined;
}

function key(year: number, month: number, day: number): string {
  // Lexical keys avoid timestamps, timezone conversion and overflow in year * days.
  return `${(BigInt(year) + YEAR_BIAS).toString().padStart(17, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Interval edges describe uncertainty; neither edge is asserted to be the recorded date. */
export function calendarInterval(date: CalendarDate): CalendarInterval {
  if (!isCalendarDate(date)) throw new RangeError('Invalid Gregorian date');
  const firstMonth = date.month ?? 1;
  const lastMonth = date.month ?? 12;
  return {
    lower: key(date.year, firstMonth, date.day ?? 1),
    upper: key(date.year, lastMonth, date.day ?? daysInMonth(date.year, lastMonth)),
  };
}

/** Inclusive, open-ended range; undefined denotes a malformed, empty or reversed range. */
export function calendarRangeBounds(range: CalendarRange): Partial<CalendarInterval> | undefined {
  if (range.gte === undefined && range.lte === undefined) return;
  const start = range.gte === undefined ? undefined : readCalendarDate(range.gte);
  const end = range.lte === undefined ? undefined : readCalendarDate(range.lte);
  if ((range.gte !== undefined && !start) || (range.lte !== undefined && !end)) return;
  const lower = start && calendarInterval(start).lower;
  const upper = end && calendarInterval(end).upper;
  if (lower !== undefined && upper !== undefined && lower > upper) return;
  return { ...(lower === undefined ? {} : { lower }), ...(upper === undefined ? {} : { upper }) };
}

/** Possible overlap of represented intervals; missing dates never match a positive range. */
export function calendarRangeMatches(date: CalendarDate | undefined, range: CalendarRange): boolean {
  const bounds = calendarRangeBounds(range);
  if (!date || !isCalendarDate(date) || !bounds) return false;
  const interval = calendarInterval(date);
  return (
    (bounds.lower === undefined || interval.upper >= bounds.lower) &&
    (bounds.upper === undefined || interval.lower <= bounds.upper)
  );
}
