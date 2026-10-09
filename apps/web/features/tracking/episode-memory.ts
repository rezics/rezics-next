import { EPISODE_PAGE, type EpisodeApi, type EpisodeGroup, type EpisodePart, type EpisodeProgress } from './episode-api.ts';

// Main's episode reads and writes in memory, for stories and tests: a series Structure read page by
// page with an opaque cursor, and per-occurrence progress with the same compare-and-set versions. Two
// `EpisodeApi`s over one `MemoryEpisodes` are two devices.

export interface MemoryStructure {
  structure: string;
  /** The root's episodes, in order. */
  mains: EpisodePart[];
  /** Groups of the root, each with its own episodes. */
  groups: (EpisodeGroup & { parts: EpisodePart[] })[];
  /** Page size, so a test can make a series span many pages without a thousand fixtures. */
  page: number;
}

export interface MemoryEpisodes extends MemoryStructure {
  progress: Map<string, EpisodeProgress>;
  /** What was asked of Main, in order. */
  calls: string[];
}

export function createMemoryEpisodes(structure: MemoryStructure): MemoryEpisodes {
  return { ...structure, page: structure.page || EPISODE_PAGE, progress: new Map(), calls: [] };
}

export function memoryEpisodeApi(store: MemoryEpisodes): EpisodeApi {
  const row = (episode: { occurrence: string }): EpisodeProgress =>
    store.progress.get(episode.occurrence) ?? { completed: false, position: null, version: 0 };
  return {
    async structure() {
      store.calls.push('structure');
      return { ok: true, data: { structure: store.structure, placesWorks: false } };
    },
    async page(_structure, { parent, after } = {}) {
      store.calls.push(`page:${parent ? 'group' : 'root'}:${after ?? 'first'}`);
      const parts = parent ? store.groups.find(group => group.occurrence === parent)?.parts ?? [] : store.mains;
      const from = after ? Number(after) : 0;
      const taken = parts.slice(from, from + store.page);
      const more = from + store.page < parts.length;
      return { ok: true, data: { parts: taken, groups: parent || from ? [] : store.groups.map(({ occurrence, label }) => ({ occurrence, label })),
        next: more ? String(from + store.page) : null } };
    },
    async resume() {
      store.calls.push('resume');
      let furthest: string | null = null;
      for (const part of store.mains) {
        if (store.progress.get(part.occurrence)?.completed) furthest = part.occurrence;
      }
      return { ok: true, data: furthest };
    },
    async progress(episode) {
      store.calls.push(`progress:${episode.occurrence.slice(-3)}`);
      return { ok: true, data: row(episode) };
    },
    async mark(episode, change) {
      const current = row(episode);
      const saved = { completed: change.completed, position: change.position === undefined ? current.position : change.position,
        version: current.version + 1 };
      store.calls.push(`mark:${episode.occurrence.slice(-3)}:${change.completed}`);
      store.progress.set(episode.occurrence, saved);
      return { ok: true, data: saved };
    },
  };
}
