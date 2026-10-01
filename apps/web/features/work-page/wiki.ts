import type { StatementGroup } from '../entity-page/types.ts';
import type { AvailableSummary, RelationsPage } from '../work-levels/types.ts';
import { relationRows } from '../work-levels/relation-rows.ts';
import { idOf } from './route.ts';

// How a Work finds its wiki. A franchise Work carries one Statement whose predicate is below and whose value is
// the wiki Zone's Realm, which the franchise wiki starter writes (G-849) and any holder's wiki may write the same
// way. The hub reads it; it never guesses a wiki from a name.

export const WIKI_ZONE_PREDICATE = 'https://rezics.com/vocab/wikiZone';

/** The Realm of the wiki Zone a Work's statements name, or null when they name none. */
export function wikiRealmOf(groups: readonly StatementGroup[]): string | null {
  for (const group of groups) {
    if (group.predicate !== WIKI_ZONE_PREDICATE) continue;
    for (const item of group.items) {
      if (item.kind === 'statement' && item.value.kind === 'resource') {
        const realm = idOf(item.value.iri);
        if (realm) return realm;
      }
    }
  }
  return null;
}

/** The wiki Zone's mounted routes the hub links to: the starter's `characters`, `chapters` and `events` Collections. */
export const wikiRoutes = [
  { key: 'characters', path: 'characters' },
  { key: 'chapterGuide', path: 'chapters' },
  { key: 'timeline', path: 'events' },
] as const;

export const wikiHref = (realm: string, path?: string) => `/r/${realm}${path ? `/${path}` : ''}`;

/**
 * The characters the Work's relations name, in Main's order. Main answers the relations read at the reader's
 * position (G-847), so a character revealed later is not in the page and nothing here filters or reveals.
 */
export function mainCharacters(page: RelationsPage, limit: number): AvailableSummary[] {
  const found = new Map<string, AvailableSummary>();
  for (const row of relationRows(page.items)) {
    for (const item of row.items) {
      const target = item.target;
      if (target.kind === 'resource' && target.summary?.status === 'available' && target.summary.type === 'character') {
        found.set(target.reference, target.summary);
      }
    }
  }
  return [...found.values()].slice(0, limit);
}
