import type { Loaded } from '../feed/types.ts';
import type { EpisodeApi, EpisodeGroup, EpisodePart } from './episode-api.ts';

// Where a reader stands in a series of episodes, from what Main holds: the Structure's occurrences in
// order and each one's completion. Main reads a Structure page by page and keeps progress per
// occurrence, so the standing is found by walking only as far as the reader has watched: the pages up
// to the first one not finished to its end, then a halving search inside it.

/** A series' page walk is bounded, so a number far past the end is refused instead of read forever. */
export const MAX_PAGES = 100;

export interface Episode extends EpisodePart {
  structure: string;
  /** Its place among its siblings, counted from 1 in Main's order. */
  number: number;
  special: boolean;
}

/** The pages read so far of one Structure parent: the main run, or one group of specials. */
export interface Walk {
  structure: string;
  parent: string | null;
  special: boolean;
  items: Episode[];
  /** The groups met on the pages read, such as Specials. */
  groups: EpisodeGroup[];
  /** Main's cursor for the next page; null once every page is read. */
  next: string | null;
  pages: number;
}

export interface Standing {
  structure: string;
  mains: Walk;
  specials: { label: string | null; walk: Walk }[];
  /** The last main episode of the run watched from the first; null when the first is not. */
  through: Episode | null;
  /** The main episode after it: the one to continue from. */
  next: Episode | null;
}

/** What marking an occurrence leaves in its position. */
export const markPosition = (episode: Pick<Episode, 'number' | 'special'>) =>
  `${episode.special ? 'special' : 'episode'}:${episode.number}`;

/** Every main episode there is, when all pages are read. */
export const totalOf = (standing: Pick<Standing, 'mains'>) => (standing.mains.next === null ? standing.mains.items.length : null);

/** Reads the next page of a walk. Returns false when there is none, or the walk is at its bound. */
export async function advance(api: EpisodeApi, walk: Walk): Promise<boolean> {
  if (walk.pages > 0 && (walk.next === null || walk.pages >= MAX_PAGES)) return false;
  const page = await api.page(walk.structure, { ...(walk.parent ? { parent: walk.parent } : {}), ...(walk.next ? { after: walk.next } : {}) });
  if (!page.ok) throw new Error(page.failure);
  for (const part of page.data.parts) {
    walk.items.push({ ...part, structure: walk.structure, number: walk.items.length + 1, special: walk.special });
  }
  walk.groups.push(...page.data.groups);
  walk.next = page.data.next;
  walk.pages++;
  return true;
}

/** The episode with this number, reading pages until it is there; null when the series ends first or is too long to reach. */
export async function reach(api: EpisodeApi, walk: Walk, number: number): Promise<Episode | null> {
  while (walk.items.length < number) {
    if (!await advance(api, walk)) break;
  }
  return walk.items[number - 1] ?? null;
}

const walkOf = (structure: string, parent: string | null): Walk => ({ structure, parent, special: parent !== null, items: [], groups: [], next: null, pages: 0 });

async function finished(api: EpisodeApi, episode: Episode): Promise<boolean> {
  const state = await api.progress(episode);
  if (!state.ok) throw new Error(state.failure);
  return state.data.completed;
}

/**
 * How many episodes are finished from the first on. The finished ones are taken to be a run, which is
 * what marking the next episode over and over leaves: pages are read while their last episode is
 * finished, and inside the first page that is not, the run's end is found by halving.
 */
async function runLength(api: EpisodeApi, walk: Walk): Promise<number> {
  if (!walk.items.length || !await finished(api, walk.items[0]!)) return 0;
  let known = 1;
  for (;;) {
    const end = walk.items.length;
    if (known < end && await finished(api, walk.items[end - 1]!)) {
      known = end;
      if (await advance(api, walk)) continue;
      return known;
    }
    if (known === end) return known;
    let low = known;
    let high = end - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (await finished(api, walk.items[middle - 1]!)) low = middle; else high = middle - 1;
    }
    return low;
  }
}

/** The series a Work has as episodes, with where the reader stands; null when it has none to track. */
export async function standingOf(api: EpisodeApi, work: string): Promise<Loaded<Standing | null>> {
  try {
    const found = await api.structure(work);
    if (!found.ok) return found;
    if (!found.data || found.data.placesWorks) return { ok: true, data: null };
    const { structure } = found.data;
    const mains = walkOf(structure, null);
    await advance(api, mains);
    // The groups on the first page are the specials; each is read from its start.
    const specials = await Promise.all(mains.groups.slice(0, 5).map(async group => {
      const walk = walkOf(structure, group.occurrence);
      await advance(api, walk);
      return { label: group.label, walk };
    }));
    const present = specials.filter(entry => entry.walk.items.length);
    if (!mains.items.length && !present.length) return { ok: true, data: null };
    const length = await runLength(api, mains);
    return { ok: true, data: { structure, mains, specials: present, through: mains.items[length - 1] ?? null,
      next: mains.items[length] ?? null } };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}
