import type { Loaded } from '../feed/types.ts';
import type { Episode, EpisodeApi } from './episode-api.ts';

// Where a reader stands in a series of episodes or chapters, from what Main holds: its list in
// reading order, the furthest occurrence it resolves as finished, and each occurrence's completion.
// Specials sit in a group of their own, so they are told apart by their parent and never counted
// toward the main run.

export type EpisodeKind = 'episode' | 'chapter';

export const kindOf = (items: readonly Episode[]): EpisodeKind => (items.some(item => item.role === 'chapter') ? 'chapter' : 'episode');

/** The number a main episode answers to: Main's sibling count, else its place in the run read. */
export function numberOf(episode: Episode, mains: readonly Episode[]): number | null {
  return episode.ordinal ?? (mains.indexOf(episode) >= 0 ? mains.indexOf(episode) + 1 : null);
}

/** What a mark leaves in the occurrence's position, so another device can tell where the reader stopped. */
export function markPosition(episode: Episode, number: number | null): string | null {
  return number === null ? null : `${episode.special ? 'special' : episode.role === 'chapter' ? 'chapter' : 'episode'}:${number}`;
}

const POSITION = /^(episode|chapter|special):([1-9]\d*)$/;
export function parseMarkPosition(position: string | null): { kind: EpisodeKind | 'special'; number: number } | null {
  const match = position ? POSITION.exec(position) : null;
  return match ? { kind: match[1] as EpisodeKind | 'special', number: Number(match[2]) } : null;
}

export interface Standing {
  kind: EpisodeKind;
  /** The first page of episodes in reading order; `complete` says it is all of them. */
  items: Episode[];
  complete: boolean;
  mains: Episode[];
  specials: Episode[];
  /** Every main episode there is, when the page holds them all. */
  total: number | null;
  /** The furthest main episode finished; null when none, undefined when it could not be told. */
  through: Episode | null | undefined;
  /** The main episode after it: the one to continue from. */
  next: Episode | null;
}

/** The main episode with this number, from the page read or by asking Main for that number. */
export async function mainNumbered(api: EpisodeApi, work: string, page: Pick<Standing, 'mains' | 'complete'>,
  number: number): Promise<Episode | null> {
  const known = page.mains.find(item => numberOf(item, page.mains) === number);
  if (known || page.complete) return known ?? null;
  const found = await api.list(work, { q: String(number), limit: 20 });
  if (!found.ok) throw new Error(found.failure);
  return found.data.items.find(item => !item.special && item.ordinal === number) ?? null;
}

/**
 * The last main episode finished, taking the finished ones to be a run from the first (the order
 * "mark the next one" produces). Main resolves the furthest finished occurrence in reading order, so
 * once a special is the furthest, the main run is found by halving over the episodes read.
 */
async function finishedRun(api: EpisodeApi, mains: readonly Episode[]): Promise<Episode | null> {
  let low = 0;
  let high = mains.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const state = await api.progress(mains[middle - 1]!);
    if (!state.ok) throw new Error(state.failure);
    if (state.data.completed) low = middle; else high = middle - 1;
  }
  return low === 0 ? null : mains[low - 1]!;
}

export async function standingOf(api: EpisodeApi, work: string): Promise<Loaded<Standing | null>> {
  try {
    const first = await api.list(work);
    if (!first.ok) return first;
    const { items, complete, resolved } = first.data;
    if (!items.length) return { ok: true, data: null };
    const mains = items.filter(item => !item.special);
    const specials = items.filter(item => item.special);
    const page = { mains, complete };
    let through: Episode | null | undefined;
    if (!resolved) through = null;
    else {
      const found = items.find(item => item.occurrence === resolved);
      if (found && !found.special) through = found;
      else if (found || !items[0]) through = complete ? await finishedRun(api, mains) : undefined;
      else {
        // Beyond the first page: this panel left its number in the position when it marked it.
        const state = await api.progress({ structure: items[0].structure, occurrence: resolved });
        const left = state.ok ? parseMarkPosition(state.data.position) : null;
        through = !left ? undefined : left.kind === 'special' ? (complete ? await finishedRun(api, mains) : undefined)
          : await mainNumbered(api, work, page, left.number) ?? undefined;
      }
    }
    const throughNumber = through ? numberOf(through, mains) : null;
    const next = through === null ? mains[0] ?? null
      : through && throughNumber !== null ? await mainNumbered(api, work, page, throughNumber + 1) : null;
    return { ok: true, data: { kind: kindOf(items), items, complete, mains, specials, through, next,
      total: complete ? mains.length : null } };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}
