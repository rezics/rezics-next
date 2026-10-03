import type { UiLocale } from '../../i18n/define.ts';
import type { AgentSummary } from './types.ts';

const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000],
  ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];

/** "3 hours ago", "in 2 days"; under a minute is "now". */
export function relativeTime(iso: string, now: number, locale: UiLocale): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, 'second');
}

/**
 * A time for `<time dateTime>`. Eden hands Main's timestamps over as Date
 * objects, whose text differs between the server's time zone and the
 * reader's; an ISO string reads the same on both sides.
 */
export const isoTime = (value: string | Date) => new Date(value).toISOString();

export const dateTime = (iso: string, locale: UiLocale) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export const date = (iso: string, locale: UiLocale) =>
  // The server cannot know the browser's time zone. Use one date on both sides
  // so the member list and invitation expiry hydrate without changing days.
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));

/** The eight-character stand-in for an Agent without a public name. */
export const agentShort = (iri: string) => iri.slice(-36, -28);

/** An Agent's public name, or "Agent 1a2b3c4d" while Main has not answered. */
export function agentLabel(agent: AgentSummary | undefined, iri: string, fallback: (short: string) => string) {
  return agent?.label ?? fallback(agentShort(iri));
}

/** Only a name chosen by its holder is a handle. */
export const shownHandle = (handle: string | null) => handle ? `@${handle}` : null;

/**
 * Report reasons are open codes (`^[a-z][a-z0-9_.-]{0,63}$`). Known ones have
 * words; an unknown one reads as a sentence rather than as a code.
 */
export function readableCode(code: string): string {
  const words = code.replace(/[_.-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}
