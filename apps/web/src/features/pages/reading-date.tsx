import { timePresentation } from '../../subject/time-presentation';

/** Presentation only: the shared time reader remains the authority for precision and supported values. */
export function ReadingDate({ value, locale }: { value: unknown; locale: string }) {
  const presentation = timePresentation(value, locale);
  if (presentation.state !== 'supported' || !presentation.structuredDate) return <span>{presentation.text}</span>;
  const [yearText, monthText, dayText] = presentation.structuredDate.split('-');
  const year = Number(yearText);
  // Intl's calendar range cannot represent the native reader's arbitrarily long signed years.
  if (year < 1 || year > 9999) return <span>{presentation.text}</span>;
  const anchor = new Date(0);
  anchor.setUTCFullYear(year, Number(monthText ?? 1) - 1, Number(dayText ?? 1));
  const text = new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    timeZone: 'UTC',
    year: 'numeric',
    ...(presentation.precision >= 10 ? { month: 'long' as const } : {}),
    ...(presentation.precision === 11 ? { day: 'numeric' as const } : {}),
  }).format(anchor);
  return (
    <time dateTime={presentation.structuredDate} title={presentation.text}>
      {text}
    </time>
  );
}
