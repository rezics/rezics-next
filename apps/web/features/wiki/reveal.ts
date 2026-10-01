import type { ZoneMember } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { readEntityProjection } from '../entity-page/read.ts';
import { iriOf } from '../work-page/route.ts';
import type { ZoneRouteRead } from '../realm/types.ts';
import type { ZoneSite } from './links.ts';
import { readMembers } from './members.ts';
import { readPositionedRoute } from './read.ts';
import type { PositionState } from './state.ts';

// What a position adds. Main has no read for "the records revealed at this chapter", so these compare two answers
// it did give, each already cut at its own position: the page of a record at the positions before and after, and a
// mounted list at a chapter and at the one before. They are bounded and say when they stopped.

/** Pages of a mounted list compared for one chapter (Main's pages are 24 members). */
export const REVEAL_PAGES = 3;

const readable = async (id: string, position: string) => {
  const page = await readEntityProjection(id, position);
  return page.ok ? true : page.failure === 'missing' ? false : null;
};

/**
 * The first chapter at which a record's page exists, found by halving the reading order between the start and the
 * position the reader is at (the record is known to be visible there). Null when a read failed or none was found.
 */
export async function firstSeen(id: string, state: PositionState): Promise<string | null> {
  const chapters = state.chooser.items.filter(item => item.role === 'chapter');
  const ordered = chapters.length ? chapters : state.chooser.items;
  const reached = state.at ? ordered.findIndex(item => item.occurrence === state.at) : state.mode === 'all' ? ordered.length - 1 : -1;
  if (reached < 0) return null;
  let low = 0;
  let high = reached;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const seen = await readable(id, ordered[middle]!.occurrence);
    if (seen === null) return null;
    if (seen) high = middle; else low = middle + 1;
  }
  return ordered[low]?.occurrence ?? null;
}

type Index = Extract<ZoneRouteRead, { kind: 'index' }>;

async function itemsAt(site: ZoneSite, segment: string, position: string | undefined) {
  const items: Index['items'] = [];
  let cursor: string | undefined;
  for (let page = 0; page < REVEAL_PAGES; page++) {
    const read = await readPositionedRoute(site.zone, `/${segment}`, cursor, position);
    if (!read.ok || read.data.kind !== 'index') return { items, complete: false };
    items.push(...read.data.items);
    if (!read.data.nextCursor) return { items, complete: true };
    cursor = read.data.nextCursor;
  }
  return { items, complete: false };
}

/**
 * The members of one mounted list that appear at `chapter` and not at the chapter before it. `complete` is false
 * when the comparison stopped at its page bound or a read failed, so the list may be shorter than the truth.
 */
export async function revealedAt(site: ZoneSite, state: PositionState, chapter: string, segment: string,
  locale: UiLocale): Promise<{ members: ZoneMember[]; complete: boolean }> {
  const ordered = state.chooser.items.filter(item => item.role === 'chapter');
  const index = ordered.findIndex(item => item.occurrence === iriOf(chapter));
  if (index < 0) return { members: [], complete: false };
  const here = { ...site, main: ordered[index]!.occurrence };
  const [now, before] = await Promise.all([itemsAt(here, segment, here.main),
    index ? itemsAt(here, segment, ordered[index - 1]!.occurrence) : { items: [], complete: true }]);
  const earlier = new Set(before.items.map(item => item.id));
  return { members: await readMembers(here, segment, now.items.filter(item => !earlier.has(item.id)), locale, state),
    complete: now.complete && before.complete };
}
