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

export const dateTime = (iso: string, locale: UiLocale) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export const date = (iso: string, locale: UiLocale) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));

/** The eight-character stand-in for an Agent without a public name. */
export const agentShort = (iri: string) => iri.slice(-36, -28);

/** An Agent's public name, or "Agent 1a2b3c4d" while Main has not answered. */
export function agentLabel(agent: AgentSummary | undefined, iri: string, fallback: (short: string) => string) {
  return agent?.label ?? fallback(agentShort(iri));
}

/** Handles Main generates from the Agent ID are not worth showing as a name. */
export const shownHandle = (handle: string | null) => handle && !handle.startsWith('agent-') ? `@${handle}` : null;

/**
 * Report reasons are open codes (`^[a-z][a-z0-9_.-]{0,63}$`). Known ones have
 * words; an unknown one reads as a sentence rather than as a code.
 */
export function readableCode(code: string): string {
  const words = code.replace(/[_.-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

/** First letters for an avatar stand-in: Latin initials, or the first character for CJK names. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = [...(parts[0] ?? '?')][0] ?? '?';
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(first)) return first;
  const second = parts.length > 1 ? [...parts[1]!][0] ?? '' : '';
  return (first + (/\p{Script=Latin}/u.test(second) ? second : '')).toUpperCase();
}
