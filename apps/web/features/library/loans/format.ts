/**
 * A loan's due date is a calendar day, stored as the last instant of that UTC
 * date so `formatDay` prints the day and no clock. Overdue is the API's loan
 * state, not a day compared here.
 */
export function dueDay(value: string): string | null {
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The instant a due date names: the end of that UTC day. */
export function dueInstant(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T23:59:59.999Z` : null;
}

/** A calendar day `days` after `day`. Both are `YYYY-MM-DD`. */
export function laterDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
