import type { TimePresentation } from '../../../subject/time-presentation';
import { GREGORIAN_CALENDAR, timePresentation } from '../../../subject/time-presentation';
import { m } from '../../../paraglide/messages.js';
import { dateReading } from '../release-fidelity/model';
import type { GameStatement } from './model';

export type GameDatePresentation = {
  kind: 'exact' | 'partial' | 'tba' | 'none' | 'invalid' | 'unsupported';
  text: string;
  structuredDate?: string;
};

/** Release TBA semantics with the shared time reader's precision, calendar and uncertainty disclosure. */
export function gameDatePresentation(statement: GameStatement, digest: string, locale: string): GameDatePresentation {
  const o = { locale: locale as never };
  const reading = dateReading([statement], statement.property.id, digest, locale);
  if (reading.kind === 'tba') return { kind: 'tba', text: m.release_fidelity_date_tba({}, o) };
  if (reading.kind === 'none') return { kind: 'none', text: timePresentation(statement.value, locale).text };

  const content: unknown = statement.value.type === 'value' ? statement.value.content : undefined;
  const value = content !== null && typeof content === 'object' && !Array.isArray(content) ? content : undefined;
  // Native Release values historically omit the calendar for Gregorian dates. Normalize only that absence;
  // an explicit foreign calendar is never converted into an admitted Gregorian value.
  const calendar = value && 'calendarmodel' in value ? value.calendarmodel : undefined;
  if (calendar !== undefined && calendar !== GREGORIAN_CALENDAR)
    return {
      kind: 'unsupported',
      text: m.time_unsupported_calendar({ calendar: typeof calendar === 'string' ? calendar : '' }, o),
    };
  const presentation: TimePresentation = timePresentation(
    value && !('calendarmodel' in value) ? { ...value, calendarmodel: GREGORIAN_CALENDAR } : content,
    locale,
  );
  if (presentation.state !== 'supported')
    return { kind: reading.kind === 'invalid' ? 'invalid' : 'unsupported', text: presentation.text };
  return {
    kind: presentation.precision === 11 ? 'exact' : 'partial',
    text: presentation.text,
    ...(presentation.structuredDate ? { structuredDate: presentation.structuredDate } : {}),
  };
}
