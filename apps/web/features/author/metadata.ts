import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { authorName, isoDate, lifespan } from './facts.ts';
import type { AuthorMessages } from './messages.ts';
import type { ExternalAuthor } from './types.ts';

/**
 * An author page's title and description for search results and link
 * previews. The locale layout adds the canonical address and `hreflang`
 * alternates from the request path.
 */
export function authorMetadata(author: ExternalAuthor, locale: UiLocale, messages: AuthorMessages): Metadata {
  const t = materializeData(messages, { locale });
  const title = authorName(author, t);
  const years = lifespan(author.facts, locale, messages);
  const description = years ? t.descriptionLifespan({ name: title, lifespan: years }) : t.description({ name: title });
  return { title, description, openGraph: { type: 'profile', title, description } };
}

/**
 * schema.org's ProfilePage for the author, as JSON safe to place inside a
 * `<script>`: `<` is escaped so a name can never close the element. `sameAs`
 * names the catalogues that identify the same person.
 */
export function authorJsonLd(author: ExternalAuthor, locale: UiLocale, messages: AuthorMessages): string {
  const t = materializeData(messages, { locale });
  const facts = author.facts;
  const birthDate = isoDate(facts?.birthDate), deathDate = isoDate(facts?.deathDate);
  const entity = { '@type': 'Person', name: authorName(author, t), identifier: author.record,
    ...(birthDate ? { birthDate } : {}), ...(deathDate ? { deathDate } : {}),
    sameAs: [author.record, ...(facts?.identifiers ?? []).map(item => item.url)] };
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: entity })
    .replaceAll('<', '\\u003c');
}
