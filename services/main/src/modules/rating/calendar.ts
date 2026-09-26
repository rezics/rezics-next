import { Temporal } from '@js-temporal/polyfill';
import { hash, iri, lit } from '../work/activate.ts';

export const DAILY_CONTEXT_ID = 'realm-daily-rating-context-v1';
export const DAILY_OBSERVATION_ID = 'realm-daily-rating-observation-v1';
export const DAILY_CONTEXT_PROFILE = `https://rezics.com/definition/${DAILY_CONTEXT_ID}`;
export const DAILY_OBSERVATION_PROFILE = `https://rezics.com/definition/${DAILY_OBSERVATION_ID}`;
export const DAILY_CADENCE = 'https://rezics.com/definition/rating-daily-v1';
export const ISO_CALENDAR = 'https://rezics.com/definition/rating-iso-calendar-v1';
export class InvalidRatingCalendar extends Error {}

export interface RatingPeriod {
  day: string;
  timeZone: string;
  calendar: 'iso8601';
  periodStart: string;
  periodEnd: string;
}

/** Named database zones only: numeric offsets are not a civil-calendar policy. */
export function canonicalRatingTimeZone(input: string): string {
  if (typeof input !== 'string' || input.length > 100
    || !/^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/.test(input)) {
    throw new InvalidRatingCalendar('a named IANA timezone is required');
  }
  try { return new Intl.DateTimeFormat('en', { timeZone: input }).resolvedOptions().timeZone; }
  catch { throw new InvalidRatingCalendar('unknown IANA timezone'); }
}

export function ratingDayPeriod(timeZone: string, trustedInstant: string): RatingPeriod {
  if (canonicalRatingTimeZone(timeZone) !== timeZone) {
    throw new InvalidRatingCalendar('timezone is not canonical');
  }
  try {
    const instant = Temporal.Instant.from(trustedInstant);
    const local = instant.toZonedDateTimeISO(timeZone);
    const start = local.startOfDay();
    const end = local.toPlainDate().add({ days: 1 }).toZonedDateTime(timeZone);
    return { day: local.toPlainDate().toString(), timeZone, calendar: 'iso8601',
      periodStart: start.toInstant().toString({ fractionalSecondDigits: 3 }),
      periodEnd: end.toInstant().toString({ fractionalSecondDigits: 3 }) };
  } catch { throw new InvalidRatingCalendar('invalid server calendar instant'); }
}

/** Check retained bounds without reinterpreting them with a newer timezone database. */
export function retainedRatingPeriod(state: Record<string, unknown>): RatingPeriod {
  if (typeof state.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)
    || typeof state.timeZone !== 'string' || state.calendar !== 'iso8601'
    || typeof state.periodStart !== 'string' || typeof state.periodEnd !== 'string') {
    throw new InvalidRatingCalendar('daily period is incomplete');
  }
  try {
    if (Temporal.PlainDate.from(state.day).toString() !== state.day) throw new Error();
    canonicalRatingTimeZone(state.timeZone);
    const start = Date.parse(state.periodStart), end = Date.parse(state.periodEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end
      || end - start > 48 * 60 * 60_000
      || new Date(start).toISOString() !== state.periodStart
      || new Date(end).toISOString() !== state.periodEnd) throw new Error();
  } catch { throw new InvalidRatingCalendar('daily period is invalid'); }
  return { day: state.day, timeZone: state.timeZone, calendar: 'iso8601',
    periodStart: state.periodStart, periodEnd: state.periodEnd };
}

export function dailyRatingSlotIri(principalId: string, context: string,
  mainVersion: string, day: string): string {
  if (!/^[0-9a-f-]{36}$/.test(principalId)
    || ![context, mainVersion].every(value => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value))
    || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InvalidRatingCalendar('invalid daily slot');
  return `urn:rezics:rating-slot:${hash(JSON.stringify({ principalId, context, mainVersion,
    cadence: DAILY_CADENCE, day }))}`;
}

export function periodTriples(period: RatingPeriod): string {
  return `rv:ratingDay ${lit(period.day)} ; rv:ratingTimeZone ${lit(period.timeZone)} ;
    rv:ratingCalendar ${iri(ISO_CALENDAR)} ;
    rv:periodStart ${lit(period.periodStart)}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
    rv:periodEnd ${lit(period.periodEnd)}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;`;
}

export function periodBinding(period: RatingPeriod): Record<string, string> {
  return { day: period.day, timeZone: period.timeZone,
    periodStart: period.periodStart, periodEnd: period.periodEnd };
}
