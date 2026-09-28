import type { UiLocale } from '../../i18n/define.ts';

// Dates in Library. Reading dates are calendar days (Main's `YYYY-MM-DD`)
// and are never shifted by a time zone; moments (added, last read) print the
// day they fall on in UTC, so the server render and the browser agree.

const day = (locale: UiLocale) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDay(value: string, locale: UiLocale): string {
  return day(locale).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/** "Jan 2 – 12, 2026", or the one day known. */
export function formatDayRange(started: string | null, finished: string | null, locale: UiLocale): string | null {
  if (started && finished) {
    return day(locale).formatRange(new Date(`${started}T00:00:00Z`), new Date(`${finished}T00:00:00Z`));
  }
  const one = finished ?? started;
  return one ? formatDay(one, locale) : null;
}

/** Today as a calendar day, the latest a reading date may be. */
export const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Main's dates as the types promise them. Eden revives `YYYY-MM-DD` and ISO
 * times as `Date`s, and the status shelves send Postgres' own text
 * (`2026-09-28 01:48:53.7+00`); Library keeps days as `YYYY-MM-DD` and
 * moments as ISO strings, which sort as text and cross to the browser as-is.
 */
export function dayText(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

export function momentText(value: unknown): string | null {
  const time = value instanceof Date ? value.getTime()
    : typeof value === 'string' ? Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
