import { m } from '../paraglide/messages.js';

export const GREGORIAN_CALENDAR = 'http://www.wikidata.org/entity/Q1985727';
export const JULIAN_CALENDAR = 'http://www.wikidata.org/entity/Q1985786';

type TimePrecision = 9 | 10 | 11;
type UnsupportedReason = 'calendar' | 'precision' | 'timezone' | 'uncertainty' | 'value';

export type TimePresentation =
  | {
      state: 'supported';
      text: string;
      date: string;
      precision: TimePrecision;
      calendar: 'gregorian' | 'julian';
      structuredDate?: string;
    }
  | { state: 'unsupported'; reason: UnsupportedReason; text: string }
  | { state: 'somevalue' | 'novalue'; text: string };

type Calendar = typeof GREGORIAN_CALENDAR | typeof JULIAN_CALENDAR;
type TimeValue = Record<string, unknown> & {
  time: string;
  precision: TimePrecision;
  calendarmodel: Calendar;
  timezone?: number;
  before?: number;
  after?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function unsupported(reason: UnsupportedReason, locale: string, value?: unknown): TimePresentation {
  const options = { locale: locale as never };
  if (reason === 'calendar')
    return {
      state: 'unsupported',
      reason,
      text: m.time_unsupported_calendar({ calendar: typeof value === 'string' ? value : '' }, options),
    };
  if (reason === 'precision')
    return {
      state: 'unsupported',
      reason,
      text: m.time_unsupported_precision({ precision: value === undefined ? '' : String(value) }, options),
    };
  if (reason === 'timezone')
    return { state: 'unsupported', reason, text: m.time_unsupported_timezone({}, options) };
  if (reason === 'uncertainty')
    return { state: 'unsupported', reason, text: m.time_unsupported_uncertainty({}, options) };
  return { state: 'unsupported', reason, text: m.time_unsupported_value({}, options) };
}

function leapYear(year: string, calendar: Calendar): boolean {
  const value = Number(year.slice(-4));
  return calendar === JULIAN_CALENDAR ? value % 4 === 0 : value % 4 === 0 && (value % 100 !== 0 || value % 400 === 0);
}

function validDate(year: string, month: string, day: string, precision: TimePrecision, calendar: Calendar): boolean {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (precision === 9) return monthNumber === 0 && dayNumber === 0;
  if (monthNumber < 1 || monthNumber > 12) return false;
  if (precision === 10) return dayNumber === 0;
  const monthDays = [31, leapYear(year, calendar) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dayNumber >= 1 && dayNumber <= monthDays[monthNumber - 1]!;
}

function structuredDate(
  year: string,
  month: string,
  day: string,
  precision: TimePrecision,
  calendar: Calendar,
  value: TimeValue,
): string | undefined {
  if (
    calendar !== GREGORIAN_CALENDAR ||
    year.startsWith('-') ||
    (value.timezone !== undefined && value.timezone !== 0) ||
    (value.before !== undefined && value.before !== 0) ||
    (value.after !== undefined && value.after !== 0)
  )
    return;
  const digits = year.slice(1).replace(/^0+/, '') || '0';
  if (digits === '0') return;
  const structuredYear = digits.length > 4 ? `+${digits}` : digits.padStart(4, '0');
  if (precision === 9) return structuredYear;
  if (precision === 10) return `${structuredYear}-${month}`;
  return `${structuredYear}-${month}-${day}`;
}

/** Read and format one admitted Wikibase time without Date, Intl, calendar conversion or filled positions. */
export function timePresentation(input: unknown, locale: string): TimePresentation {
  const options = { locale: locale as never };
  if (isRecord(input) && input.type === 'somevalue')
    return { state: 'somevalue', text: m.time_value_unknown({}, options) };
  if (isRecord(input) && input.type === 'novalue') return { state: 'novalue', text: m.time_value_none({}, options) };
  if (isRecord(input) && input.type === 'value') {
    if (!Object.hasOwn(input, 'content')) return unsupported('value', locale);
    input = input.content;
  }
  if (!isRecord(input)) return unsupported('value', locale);
  const value = input;
  if (Object.keys(value).some((key) => !['time', 'precision', 'calendarmodel', 'timezone', 'before', 'after'].includes(key)))
    return unsupported('value', locale);
  if (!Number.isInteger(value.precision) || ![9, 10, 11].includes(value.precision as number))
    return unsupported('precision', locale, value.precision);
  if (value.calendarmodel !== GREGORIAN_CALENDAR && value.calendarmodel !== JULIAN_CALENDAR)
    return unsupported('calendar', locale, value.calendarmodel);
  if (
    Object.hasOwn(value, 'timezone') &&
    (typeof value.timezone !== 'number' || !Number.isSafeInteger(value.timezone))
  )
    return unsupported('timezone', locale);
  for (const key of ['before', 'after'] as const) {
    const uncertainty = value[key];
    if (Object.hasOwn(value, key) && (typeof uncertainty !== 'number' || !Number.isSafeInteger(uncertainty) || uncertainty < 0))
      return unsupported('uncertainty', locale);
  }
  if (typeof value.time !== 'string' || value.time.length > 33)
    return unsupported('value', locale);
  const match = /^([+-][0-9]{4,16})-([0-9]{2})-([0-9]{2})T00:00:00Z$/.exec(value.time);
  if (!match || !/[1-9]/.test(match[1]!.slice(1))) return unsupported('value', locale);
  const precision = value.precision as TimePrecision;
  const calendar = value.calendarmodel as Calendar;
  const year = match[1]!;
  const month = match[2]!;
  const day = match[3]!;
  if (!validDate(year.slice(1), month, day, precision, calendar)) return unsupported('value', locale);

  const date = precision === 9 ? year : precision === 10 ? `${year}-${month}` : `${year}-${month}-${day}`;
  const precisionText =
    precision === 9
      ? m.time_precision_year({}, options)
      : precision === 10
        ? m.time_precision_month({}, options)
        : m.time_precision_day({}, options);
  const calendarText =
    calendar === GREGORIAN_CALENDAR ? m.time_calendar_gregorian({}, options) : m.time_calendar_julian({}, options);
  const metadata: string[] = [];
  if (Object.hasOwn(value, 'timezone'))
    metadata.push(m.time_timezone({ minutes: String(value.timezone) }, options));
  if (Object.hasOwn(value, 'before') || Object.hasOwn(value, 'after'))
    metadata.push(
      m.time_uncertainty(
        {
          before: Object.hasOwn(value, 'before') ? String(value.before) : m.time_not_set({}, options),
          after: Object.hasOwn(value, 'after') ? String(value.after) : m.time_not_set({}, options),
        },
        options,
      ),
    );
  const text = m.time_value(
    { date, precision: precisionText, calendar: calendarText, metadata: metadata.length ? ` · ${metadata.join(' · ')}` : '' },
    options,
  );
  const jsonLdDate = structuredDate(year, month, day, precision, calendar, value as TimeValue);
  return {
    state: 'supported',
    text,
    date,
    precision,
    calendar: calendar === GREGORIAN_CALENDAR ? 'gregorian' : 'julian',
    ...(jsonLdDate ? { structuredDate: jsonLdDate } : {}),
  };
}
