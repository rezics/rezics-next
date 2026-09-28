import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import { authorHref } from '../author/route.ts';
import { workHref } from '../work-page/route.ts';
import type { ProfileMessages } from './messages.ts';
import type { AgentWorksPage, CreditedWork, CreditRole, ShelfCard } from './types.ts';

const roleOrder: readonly CreditRole[] = ['author', 'translator', 'editor'];

/**
 * How a work row credits the profile's Agent, as Goodreads writes
 * "Jane Austen, Lin Mei (Translator)": the name alone for an author, with
 * the roles in brackets otherwise.
 */
export function creditLine(name: string, roles: readonly CreditRole[], locale: UiLocale,
  messages: ProfileMessages): string {
  const t = materializeData(messages, { locale });
  const sorted = roleOrder.filter(role => roles.includes(role));
  if (sorted.length === 1 && sorted[0] === 'author') return name;
  const label = { author: t.roleAuthor, translator: t.roleTranslator, editor: t.roleEditor };
  const list = new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' });
  return t.creditWithRoles({ name, roles: list.format(sorted.map(role => label[role])) });
}

/** A credited Work as a catalogue card: cover, title, the profile's credit, Global rating, pitch and serial state. */
export function creditedCard(item: CreditedWork, name: string, handle: string, locale: UiLocale,
  messages: ProfileMessages): CatalogueWork {
  return { id: item.id, href: workHref(item.id.slice(-36)), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types),
    authors: [{ name: creditLine(name, item.attribution.map(credit => credit.role), locale, messages),
      href: authorHref({ kind: 'agent', handle }) }],
    rating: item.rating ? { mean: item.rating.mean, count: item.rating.count, max: item.rating.scale.max } : null,
    tagline: item.tagline, completion: item.completionStatus };
}

/**
 * A Work on someone's status shelf. Main's shelf read names its title, cover
 * and types, so it wears its usual cover, but no author or rating.
 */
export function shelfCard(card: ShelfCard): CatalogueWork {
  return { id: card.id, href: workHref(card.id.slice(-36)), title: card.title, cover: card.cover,
    kind: coverKindOf(card.types), authors: [], rating: null };
}

/**
 * The line under "{name}'s works", as Goodreads sums up an author: how many
 * Works, and the mean over every rating they received. The mean is given only
 * when the whole list is loaded and every rating answers the same question
 * on the same scale; otherwise it would describe a sample.
 */
export function worksSummary(page: Pick<AgentWorksPage, 'items' | 'nextCursor'>):
  { works: number; complete: boolean; rating: { mean: number; count: number; max: number } | null } {
  const rated = page.items.flatMap(item => (item.rating ? [item.rating] : []));
  const complete = page.nextCursor === null;
  const count = rated.reduce((total, rating) => total + rating.count, 0);
  const sameQuestion = new Set(rated.map(rating => `${rating.context}\0${rating.scale.max}`)).size === 1;
  return { works: page.items.length, complete,
    rating: complete && count > 0 && sameQuestion
      ? { mean: rated.reduce((total, rating) => total + rating.sum, 0) / count, count, max: rated[0]!.scale.max }
      : null };
}
