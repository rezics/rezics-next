import type { Loaded } from '../feed/types.ts';
import type { EpisodeApi, EpisodeGroup, EpisodePart } from './episode-api.ts';

// Inventory pages supply the episode chooser. Progress facts come from Main's one resume read.
// No inventory window, occurrence scan or client completion set establishes coverage.

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
  /** Main exposes no episode successor in its resume response; inventory is never used to infer it. */
  next: null;
  /**
   * The furthest main occurrence completed, named by one authoritative resume response.
   * Null means Main did not supply a saved progress fact.
   */
  furthest: EpisodePart | null;
}

/** What marking an occurrence leaves in its position. */
export const markPosition = (episode: Pick<Episode, 'number' | 'special'>) =>
  `${episode.special ? 'special' : 'episode'}:${episode.number}`;

/** Reads the next page of a walk. Returns false when there is none, or the walk is at its bound. */
export async function advance(api: EpisodeApi, walk: Walk, current: () => boolean = () => true): Promise<boolean> {
  if (!current()) return false;
  if (walk.pages > 0 && (walk.next === null || walk.pages >= MAX_PAGES)) return false;
  const page = await api.page(walk.structure, { ...(walk.parent ? { parent: walk.parent } : {}), ...(walk.next ? { after: walk.next } : {}) });
  // A cancelled page must not change the chooser shared with a newer selection.
  if (!current()) return false;
  if (!page.ok) throw new Error(page.failure);
  const occurrences = new Set(walk.items.map(item => item.occurrence));
  for (const part of page.data.parts) {
    if (occurrences.has(part.occurrence)) continue;
    occurrences.add(part.occurrence);
    walk.items.push({ ...part, structure: walk.structure, number: walk.items.length + 1, special: walk.special });
  }
  const groups = new Set(walk.groups.map(group => group.occurrence));
  for (const group of page.data.groups) {
    if (groups.has(group.occurrence)) continue;
    groups.add(group.occurrence);
    walk.groups.push(group);
  }
  walk.next = page.data.next;
  walk.pages++;
  return true;
}

/** The episode with this number, reading pages until it is there; null when the series ends first; budget exhaustion is a failure. */
export async function reach(api: EpisodeApi, walk: Walk, number: number, current: () => boolean = () => true): Promise<Episode | null> {
  while (current() && walk.items.length < number) {
    if (!await advance(api, walk, current)) {
      if (!current()) return null;
      if (walk.next !== null) throw new Error('budget');
      break;
    }
  }
  return current() ? walk.items.find(episode => episode.number === number) ?? null : null;
}

const walkOf = (structure: string, parent: string | null): Walk => ({ structure, parent, special: parent !== null, items: [], groups: [], next: null, pages: 0 });

/** The series a Work has as episodes, with where the reader stands; null when it has none to track. */
export async function standingOf(api: EpisodeApi, work: string, current: () => boolean = () => true): Promise<Loaded<Standing | null>> {
  try {
    if (!current()) return { ok: false, failure: 'unavailable' };
    const found = await api.structure(work);
    if (!current()) return { ok: false, failure: 'unavailable' };
    if (!found.ok) return found;
    if (!found.data || found.data.placesWorks) return { ok: true, data: null };
    const { structure } = found.data;
    const mains = walkOf(structure, null);
    await advance(api, mains, current);
    if (!current()) return { ok: false, failure: 'unavailable' };
    // The groups on the first page are the specials; each is read from its start.
    const specials = await Promise.all(mains.groups.slice(0, 5).map(async group => {
      const walk = walkOf(structure, group.occurrence);
      await advance(api, walk, current);
      return { label: group.label, walk };
    }));
    if (!current()) return { ok: false, failure: 'unavailable' };
    const present = specials.filter(entry => entry.walk.items.length);
    const resumed = await api.resume(work);
    if (!current()) return { ok: false, failure: 'unavailable' };
    if (!resumed.ok) return resumed;
    return { ok: true, data: { structure, mains, specials: present, next: null, furthest: resumed.data } };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}
