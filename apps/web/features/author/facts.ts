import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { AuthorMessages } from './messages.ts';
import type { AuthorDate, AuthorFacts, ExternalAuthor } from './types.ts';

// Plain module: pages, metadata and stories name an author and format their dates alike.

/** The name a page shows: Open Library's, or the author's Open Library ID while REZICS has none. */
export function authorName(author: Pick<ExternalAuthor, 'name' | 'key'>,
  t: { unnamedAuthor: (values: { id: string }) => string }): string {
  return author.name?.displayName ?? t.unnamedAuthor({ id: author.key.replace(/^\/authors\//, '') });
}

function calendarDate(year: number, month = 1, day = 1): Date {
  const value = new Date(Date.UTC(2000, month - 1, day));
  value.setUTCFullYear(year);
  return value;
}

const year = (date: AuthorDate, locale: UiLocale, messages: AuthorMessages) => {
  const text = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric' }).format(calendarDate(date.year!));
  return date.approximate ? materializeData(messages, { locale }).circa({ year: text }) : text;
};

/**
 * A source date in the reader's language as precisely as the source states
 * it: "December 16, 1775", "1775年12月16日", "c. 1717". A date the source
 * wrote in another form is shown as written.
 */
export function formatAuthorDate(date: AuthorDate, locale: UiLocale, messages: AuthorMessages): string {
  if (date.year === null) return date.text;
  if (date.month === null) return year(date, locale, messages);
  const text = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long',
    ...(date.day === null ? {} : { day: 'numeric' }) }).format(calendarDate(date.year, date.month, date.day ?? 1));
  return date.approximate ? materializeData(messages, { locale }).circa({ year: text }) : text;
}

/** "1775–1817", "c. 1717–1763" or "Born 1640", as a byline under the name; null without a year. */
export function lifespan(facts: Pick<AuthorFacts, 'birthDate' | 'deathDate'> | null, locale: UiLocale,
  messages: AuthorMessages): string | null {
  const t = materializeData(messages, { locale });
  const birth = facts?.birthDate?.year ? year(facts.birthDate, locale, messages) : null;
  const death = facts?.deathDate?.year ? year(facts.deathDate, locale, messages) : null;
  if (birth && death) return t.lifespan({ birth, death });
  return birth ? t.bornIn({ year: birth }) : death ? t.diedIn({ year: death }) : null;
}

/** "September 28, 2026": when the facts were retrieved, in the reader's language. */
export function retrievedOn(fetchedAt: string, locale: UiLocale): string | null {
  const date = new Date(fetchedAt);
  return Number.isNaN(date.getTime()) ? null
    : new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'long' }).format(date);
}

/** An ISO date (or year) for schema.org when the source states one plainly. */
export function isoDate(date: AuthorDate | null | undefined): string | undefined {
  if (!date?.year || date.approximate) return undefined;
  const pad = (value: number, size: number) => String(value).padStart(size, '0');
  return [pad(date.year, 4), ...date.month ? [pad(date.month, 2)] : [], ...date.day ? [pad(date.day, 2)] : []].join('-');
}
