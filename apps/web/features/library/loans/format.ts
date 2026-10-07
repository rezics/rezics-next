import type { UiLocale } from '../../../i18n/define.ts';

/**
 * Due times print in UTC so the server render and the browser agree, the same
 * reason Library prints moments in UTC. The zone is written after the time:
 * `dateStyle` cannot be combined with `timeZoneName`.
 */
export function formatDue(value: string, locale: UiLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(date)} UTC`;
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
