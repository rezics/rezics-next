import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { authorHref } from '../author/route.ts';
import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import { AlsoEnjoyedRow } from './also-enjoyed-row.tsx';
import type { WorkPageMessages } from './messages.ts';
import { workHref } from './route.ts';
import type { ScopeRealm } from './scope-bar.tsx';
import { realmLabel } from './scope-labels.ts';
import type { AlsoEnjoyedItem, AlsoEnjoyedPage, Loaded } from './types.ts';

export type AlsoEnjoyedBasis = AlsoEnjoyedItem['basis'];

/**
 * A recommended Work as every catalogue card draws it: the cover by Work id,
 * authors linked to their pages (as Discover's cards link them) and the rating.
 */
export function alsoEnjoyedWork(item: AlsoEnjoyedItem): CatalogueWork {
  return { id: item.id, href: workHref(item.id.slice(-36)), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types),
    authors: item.primaryCredits.flatMap(credit => credit.displayName ? [{ name: credit.displayName,
      href: credit.participantKind === 'agent' ? authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent })
        : credit.provider === 'open-library' && credit.key ? authorHref({ kind: 'external', key: credit.key })
        : null }] : []),
    rating: item.rating ? { mean: item.rating.mean, count: item.rating.count, max: item.rating.scale.max } : null,
    completion: item.completionStatus };
}

/**
 * One row per reason Main gives, in its order: what this Work's readers also
 * enjoyed, then Works like it, then its communities' picks. Each row is titled
 * by its reason, so a similar Work is never passed off as a co-readers' pick.
 */
export function alsoEnjoyedGroups(items: readonly AlsoEnjoyedItem[]):
  { basis: AlsoEnjoyedBasis; works: CatalogueWork[] }[] {
  const groups = new Map<AlsoEnjoyedBasis, CatalogueWork[]>();
  for (const item of items) groups.set(item.basis, [...groups.get(item.basis) ?? [], alsoEnjoyedWork(item)]);
  return [...groups].map(([basis, works]) => ({ basis, works }));
}

/**
 * A row's honest title: "Readers also enjoyed" only for co-readers' picks,
 * "Similar books" (or works) for Works that share its genres, kind and
 * language, and "More from <community>" for a community's picks. Main takes
 * those from the first communities that feature the Work, so one community is
 * named and several are not.
 */
export function alsoEnjoyedTitle(basis: AlsoEnjoyedBasis, { book, realms }: {
  /** Whether the Work is shown as a book, as its cover draws it. */
  book: boolean;
  /** The communities that feature the Work, in Main's order. */
  realms: readonly ScopeRealm[];
}, messages: WorkPageMessages, locale: UiLocale): string {
  const t = materializeData(messages, { locale });
  if (basis === 'co-readers') return t.alsoEnjoyed;
  if (basis === 'similar') return book ? t.similarBooks : t.similarWorks;
  return realms.length === 1 ? t.moreFromRealm({ realm: realmLabel(realms[0]!, messages, locale) }) : t.moreFromRealms;
}

/**
 * Works to read next, as Goodreads sets them under a book: a paged row of
 * covers for each reason Main gives. It is an invitation, not the Work's
 * record, so it leaves nothing behind when Main has no picks or cannot answer.
 */
export function AlsoEnjoyedSection({ alsoEnjoyed, book, realms, avatarQuery, locale, messages }: {
  alsoEnjoyed: Loaded<AlsoEnjoyedPage>; book: boolean; realms: readonly ScopeRealm[]; avatarQuery?: string;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  if (!alsoEnjoyed.ok) return null;
  return alsoEnjoyedGroups(alsoEnjoyed.data.items).map(group => <AlsoEnjoyedRow key={group.basis}
    id={`work-also-${group.basis}`} title={alsoEnjoyedTitle(group.basis, { book, realms }, messages, locale)}
    works={group.works} avatarQuery={avatarQuery} locale={locale} />);
}
