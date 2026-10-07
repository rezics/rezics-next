import { EPISODE_PAGE, type Episode, type EpisodeApi, type EpisodeProgress } from './episode-api.ts';

// Main's episode reads and writes in memory, for stories and tests: the same reading order, the same
// furthest-finished resolution (the last finished occurrence in reading order, so a special finished
// last is the furthest) and the same compare-and-set versions. Two `EpisodeApi`s over one
// `MemoryEpisodes` are two devices.

export interface MemoryEpisodes {
  /** Every episode in reading order. */
  items: Episode[];
  progress: Map<string, EpisodeProgress>;
  /** Page size, so a test can make a series longer than one page without a thousand fixtures. */
  page: number;
  /** What was asked of Main, in order. */
  calls: string[];
}

export function createMemoryEpisodes(items: Episode[], page = EPISODE_PAGE): MemoryEpisodes {
  return { items, progress: new Map(), page, calls: [] };
}

export function memoryEpisodeApi(store: MemoryEpisodes): EpisodeApi {
  const row = (episode: Pick<Episode, 'occurrence'>): EpisodeProgress =>
    store.progress.get(episode.occurrence) ?? { completed: false, position: null, version: 0 };
  return {
    async list(_work, { q, limit = EPISODE_PAGE } = {}) {
      store.calls.push(q ? `list:${q}` : 'list');
      const matches = store.items.filter(item => !q || String(item.ordinal) === q || item.label?.toLowerCase().includes(q.toLowerCase()));
      const items = matches.slice(0, Math.min(limit, store.page));
      const finished = store.items.filter(item => row(item).completed);
      return { ok: true, data: { items, complete: !q && matches.length <= items.length,
        resolved: finished.at(-1)?.occurrence ?? null } };
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
