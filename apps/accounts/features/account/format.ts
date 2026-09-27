const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000],
  ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];

/** "3 hours ago", computed once on the server so hydration sees the same text. */
export function relativeTime(iso: string, now: Date, locale: string): string {
  const seconds = Math.round((Date.parse(iso) - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

export function calendarDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
}
