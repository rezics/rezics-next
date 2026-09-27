import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import { type BrowseScope, workHref } from './scope.ts';
import type { DiscoveryItem } from './types.ts';

/**
 * A discovery item as a catalogue card, opening the Work in the scope being
 * browsed. In Mine the rating is the reader's own. Main's primary credits do
 * not carry names for external author references yet, so those add none.
 */
export function discoveryWork(item: DiscoveryItem, scope: BrowseScope): CatalogueWork {
  return { id: item.id, href: workHref(item.id, scope), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types),
    authors: item.primaryCredits.flatMap(credit => credit.displayName ? [credit.displayName] : []),
    rating: item.rating ? { mean: item.rating.mean, count: item.rating.count, max: item.rating.scale.max,
      own: scope.kind === 'mine' } : null,
    tagline: item.tagline, completion: item.completionStatus };
}
