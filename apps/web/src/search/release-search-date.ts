import { isCalendarDate, type CalendarDate } from '@rezics/filter';

/** Localize only recorded components, keeping the source's astronomical year. */
export function releaseDateText(value: CalendarDate, locale: string): string | undefined {
  if (!isCalendarDate(value)) return;
  const year = new Intl.NumberFormat(locale, { useGrouping: false }).format(value.year);
  if (value.month === undefined) return year;

  // A leap-year template supplies Gregorian ordering, month names and punctuation.
  // Its year and any unrecorded day never enter the displayed date. Native years
  // include zero, negative and safe-integer extremes outside JavaScript Date's range.
  const template = new Date(Date.UTC(2000, value.month - 1, value.day ?? 1));
  return new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    ...(value.day === undefined ? {} : { day: 'numeric' }),
  })
    .formatToParts(template)
    .map((part) => (part.type === 'year' ? year : part.value))
    .join('');
}

/** The first valid recorded date within the existing four-property/three-value preview. */
export function hitCalendarDate(
  facts: Readonly<Record<string, readonly unknown[]>> | undefined,
  properties?: readonly string[],
): CalendarDate | undefined {
  for (const property of (properties ?? Object.keys(facts ?? {})).slice(0, 4)) {
    if (!facts || !Object.hasOwn(facts, property)) continue;
    for (const value of facts[property]?.slice(0, 3) ?? []) {
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'time' && isCalendarDate(value))
        return {
          year: value.year,
          ...(value.month === undefined ? {} : { month: value.month }),
          ...(value.day === undefined ? {} : { day: value.day }),
        };
    }
  }
}
