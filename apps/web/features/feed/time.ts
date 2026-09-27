const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000], ['month', 30 * 86_400_000], ['week', 7 * 86_400_000],
  ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
];

/**
 * "3 hours ago", in the reader's language. `now` comes from the server render
 * so the server and the browser print the same text; under a minute is "now".
 */
export function relativeTime(iso: string, now: number, locale: string, style: 'long' | 'narrow' = 'narrow'): string {
  const elapsed = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
  for (const [unit, size] of units) {
    if (Math.abs(elapsed) >= size) return format.format(Math.round(elapsed / size), unit);
  }
  return format.format(0, 'second');
}

/** The full date and time, for a tooltip and `<time dateTime>`. */
export function absoluteTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
}
