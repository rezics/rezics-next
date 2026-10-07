import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { commandKey } from '../feed/api.ts';
import { failureOf, type Loaded, settle, uuidOf } from '../feed/types.ts';

// The browser side of episode and chapter progress. A series Structure places its episodes (or
// chapters) as occurrences; Main lists them in reading order (`/v1/reading-positions`) and keeps the
// reader's own completion per occurrence (`/v1/compositions/{id}/occurrences/{id}/progress`). Nothing
// here stores progress: every write is Main's compare-and-set, and a second device reads the same rows.

/** One episode or chapter as a Structure occurrence. */
export interface Episode {
  occurrence: string;
  structure: string;
  /** The Structure itself for a main episode; a group (such as Specials) for anything set apart. */
  parent: string;
  role: 'part' | 'chapter';
  /** Its one-based place among its siblings, as Main counts it. */
  ordinal: number | null;
  label: string | null;
  special: boolean;
}

/** One page of a Work's episodes in reading order, with the reader's furthest finished occurrence. */
export interface EpisodePage {
  items: Episode[];
  /** True when `items` is every episode there is. */
  complete: boolean;
  /** The occurrence Main resolves as the reader's furthest finished one, or null when none. */
  resolved: string | null;
}

export interface EpisodeProgress { completed: boolean; position: string | null; version: number }

export interface EpisodeApi {
  /** The first page, or with `q` the occurrences Main finds by that number or title. */
  list(work: string, query?: { q?: string; limit?: number }): Promise<Loaded<EpisodePage>>;
  progress(episode: Pick<Episode, 'structure' | 'occurrence'>): Promise<Loaded<EpisodeProgress>>;
  /**
   * Sets one occurrence's completion. A write another device got to first is read again and the
   * same change applied once more: the reader's intent is a state, not a delta.
   */
  mark(episode: Pick<Episode, 'structure' | 'occurrence'>, change: { completed: boolean; position?: string | null }):
    Promise<Loaded<EpisodeProgress>>;
}

/** Main's own page size for the chooser. */
export const EPISODE_PAGE = 100;
const IRI = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export function mainEpisodeApi(actingSubject: string, main: () => MainClient = browserMainApi): EpisodeApi {
  const progress = (episode: Pick<Episode, 'structure' | 'occurrence'>) =>
    main().v1.compositions({ id: uuidOf(episode.structure) }).occurrences({ occurrence: uuidOf(episode.occurrence) }).progress;
  const read = (episode: Pick<Episode, 'structure' | 'occurrence'>) =>
    settle(() => progress(episode).get({ query: { actingSubject } }));
  return {
    async list(work, { q, limit = EPISODE_PAGE } = {}) {
      const page = await settle(() => main().v1['reading-positions']({ work: uuidOf(work) }).get({
        query: { actingSubject, position: 'mine', limit, ...(q ? { q } : {}) } }));
      if (!page.ok) return page;
      const items = page.data.items.flatMap((item): Episode[] => item.role === 'group' || !item.target ? [] : [{
        occurrence: item.occurrence, structure: item.structure, parent: item.parent, role: item.role,
        ordinal: item.ordinal ?? null, label: item.displayLabel ?? item.labels?.[0]?.value ?? null,
        special: item.parent !== item.structure }]);
      return { ok: true, data: { items, complete: page.data.complete, resolved: IRI.test(page.data.resolved) ? page.data.resolved : null } };
    },
    progress: read,
    async mark(episode, change) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await read(episode);
        if (!current.ok) return current;
        try {
          const { data, error } = await progress(episode).put({ actingSubject, expectedVersion: current.data.version,
            completed: change.completed, position: change.position === undefined ? current.data.position : change.position },
          { headers: { 'idempotency-key': commandKey() } });
          if (!error) return data ? { ok: true, data } : { ok: false, failure: 'unavailable' };
          if (error.status !== 409) return { ok: false, failure: failureOf(error.status, error.value) };
        } catch {
          return { ok: false, failure: 'unavailable' };
        }
      }
      return { ok: false, failure: 'moved' };
    },
  };
}
