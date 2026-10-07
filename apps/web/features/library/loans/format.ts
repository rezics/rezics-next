import type { UiLocale } from '../../../i18n/define.ts';

/**
 * A due instant in the viewer's language and time zone. Midnight in that zone
 * is a calendar day: the clock carries nothing, so only the date is shown.
 * `timeZone` is the viewer's when omitted.
 */
export function formatDue(value: string, locale: UiLocale, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => clock.find(item => item.type === type)?.value ?? '';
  const timeless = part('hour') === '00' && part('minute') === '00' && part('second') === '00';
  return new Intl.DateTimeFormat(locale, timeless
    ? { dateStyle: 'medium', timeZone: zone }
    : { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(date);
}

/** A `datetime-local` value for an instant, in the browser's zone. Dialogs open on the client. */
export function localInput(instant: number): string {
  const date = new Date(instant);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value names, or null when it is empty or not a time. */
export function instantFromLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A calendar day stored as midnight UTC, matching the date Library already keeps. */
export function dayInstant(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : null;
}
