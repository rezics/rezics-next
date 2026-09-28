import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import { authorHref } from '../author/route.ts';
import { type BrowseScope, workHref } from './scope.ts';
import type { DiscoveryItem } from './types.ts';

/**
 * A discovery item as a catalogue card, opening the Work in the scope being
 * browsed. In Mine the rating is the reader's own. Main's primary credits do
 * not carry names for every external author reference, so unnamed ones add none.
 */
export function discoveryWork(item: DiscoveryItem, scope: BrowseScope): CatalogueWork & {
  authorLinks: readonly { name: string; href: string | null }[];
} {
  const authorLinks = item.primaryCredits.flatMap(credit => {
    if (!credit.displayName) return [];
    const href = credit.participantKind === 'agent' ? credit.handle
      ? authorHref({ kind: 'agent', handle: credit.handle }) : null
      : credit.provider === 'open-library' && credit.key
        ? authorHref({ kind: 'external', key: credit.key }) : null;
    return [{ name: credit.displayName, href }];
  });
  return { id: item.id, href: workHref(item.id, scope), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types),
    authors: authorLinks.map(author => author.name), authorLinks,
    rating: item.rating ? { mean: item.rating.mean, count: item.rating.count, max: item.rating.scale.max,
      own: scope.kind === 'mine' } : null,
    tagline: item.tagline, completion: item.completionStatus };
}
