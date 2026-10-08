import type { ZoneMember } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { iriOf } from '../work-page/route.ts';
import type { ZoneRouteRead } from '../realm/types.ts';
import type { ZoneSite } from './links.ts';
import { readMembers } from './members.ts';
import { readFirstAppearance, readPositionedRoute, type ChooserItem } from './read.ts';
import type { PositionState } from './state.ts';

// What a position adds. A record's first appearance is a bounded Main read. Main has no read for "the records
// revealed at this chapter", so `revealedAt` compares two answers it did give, each already cut at its own
// position: a mounted list at a chapter and at the one before. It is bounded and says when it stopped.

/** Pages of a mounted list compared for one chapter (Main's pages are 24 members). */
export const REVEAL_PAGES = 3;

/**
 * The first chapter at which a record is visible to the reader, from Main's bounded read of where the record is
 * revealed. Null when the reader is not at a position, the record is not placed by position, Main found no
 * chapter within its bound, or the read failed.
 */
export async function firstSeen(id: string, state: PositionState): Promise<ChooserItem | null> {
  if (!state.at && state.mode !== 'all') return null;
  return readFirstAppearance(state.work, iriOf(id), state.main);
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

/** How the chapter before this one settled. `none` is the first chapter. `bound` and `failed` are unknown. */
export type ChapterBefore =
  | { status: 'found'; occurrence: string }
  | { status: 'none' }
  | { status: 'bound' }
  | { status: 'failed' };

/**
 * The members of one mounted list that appear at `chapter` and not at the chapter before it.
 * `found` compares with that chapter. `none` (the first chapter) treats everything visible as revealed here.
 * `bound` or a failed read is not the first chapter: nothing is listed, so no member is called revealed here.
 * `complete` is false when the comparison stopped at its page bound or a read failed, so a list may be shorter
 * than the truth.
 */
export async function revealedAt(site: ZoneSite, state: PositionState, chapter: string, before: ChapterBefore,
  segment: string, locale: UiLocale): Promise<{ members: ZoneMember[]; complete: boolean }> {
  if (before.status === 'bound' || before.status === 'failed') return { members: [], complete: false };
  const here = { ...site, main: chapter };
  const [now, earlier] = await Promise.all([itemsAt(here, segment, chapter),
    before.status === 'found' ? itemsAt(here, segment, before.occurrence) : { items: [], complete: true }]);
  const seen = new Set(earlier.items.map(item => item.id));
  return { members: await readMembers(here, segment, now.items.filter(item => !seen.has(item.id)), locale, state),
    complete: now.complete && earlier.complete };
}
