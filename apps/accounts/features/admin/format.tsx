'use client';

import { useLocale } from '../../i18n/client.ts';

const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000],
  ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];

function relativeTime(iso: string, now: number, locale: string): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

export function exactTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** A relative time (“3 hours ago”) with the exact local time on hover. The
 * server renders in UTC, so the text may change once the browser takes over. */
export function Time({ iso, className }: { iso: string; className?: string }) {
  const locale = useLocale().current;
  return <time dateTime={iso} title={exactTime(iso, locale)} className={className} suppressHydrationWarning>
    {relativeTime(iso, Date.now(), locale)}</time>;
}

/** The exact local date and time, as the browser's time zone shows it. */
export function ExactTime({ iso }: { iso: string }) {
  const locale = useLocale().current;
  return <time dateTime={iso} suppressHydrationWarning>{exactTime(iso, locale)}</time>;
}

/** A date without time of day, as UTC so server and browser agree. */
export function DateOnly({ iso }: { iso: string }) {
  const locale = useLocale().current;
  return <time dateTime={iso} title={exactTime(iso, locale)} suppressHydrationWarning>
    {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso))}</time>;
}

export function count(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Names from mixed scripts: the list pattern of the interface language. */
export function nameList(names: string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}

const spans: [Intl.NumberFormatOptions['unit'] & string, number][] = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
/** A length of time in its largest whole unit (“3 hours”, “3 小时”), at least a minute. */
export function duration(milliseconds: number, locale: string): string {
  const size = Math.abs(milliseconds);
  // Days from two, hours from one: “26 hours” reads better than “1 day”.
  const [unit, length] = spans.find(([name, span]) => size >= span * (name === 'day' ? 2 : 1)) ?? spans.at(-1)!;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(Math.max(1, Math.round(size / length)));
}
