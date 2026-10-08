import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { type Loaded, settle, uuidOf } from '../feed/types.ts';
import { type EpisodeApi, type EpisodeProgress, type ProgressStale, mainEpisodeApi } from './episode-api.ts';
import type { ChapterRef, RouteRef } from './media.ts';

// Reads that name a manga chapter or a game's parts, and the resume read that places the reader
// on another device. Writes go through the same occurrence progress as episodes.

export interface MediaApi {
  /** The Work's types, so the served registry can name its kind. Null when the Work is missing. */
  types(work: string): Promise<Loaded<string[] | null>>;
  /** Volumes this Work places, in Main's order. Empty when it places none. */
  volumes(work: string): Promise<Loaded<{ number: number; label: string | null; work: string }[]>>;
  /**
   * The Book's chapters in reading order. A volume group contributes its own chapters under that
   * volume. Null when the Work is not a Book.
   */
  chapters(work: string): Promise<Loaded<ChapterRef[] | null>>;
  /** Named parts of the Work's composition: required parts are the game, the others are routes. */
  routes(work: string): Promise<Loaded<RouteRef[]>>;
  /** The occurrence the resume read names, or null when the reader has not completed one. */
  resume(work: string): Promise<Loaded<string | null>>;
  progress(part: { structure: string; occurrence: string }): Promise<Loaded<EpisodeProgress>>;
  /** Writes one occurrence and, when another device wrote first, returns both sides. */
  mark(part: { structure: string; occurrence: string }, change: { completed: boolean; position?: string | null }):
    Promise<Loaded<EpisodeProgress> | ProgressStale>;
}

const PAGE = 20;
const MOVED_RESTARTS = 4;
const MOVED_DELAY_MS = 250;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

async function restarted<T>(read: () => Promise<Loaded<T>>): Promise<Loaded<T>> {
  for (let attempt = 0; ; attempt++) {
    const answer = await read();
    if (answer.ok || answer.failure !== 'moved' && answer.failure !== 'unavailable' || attempt === MOVED_RESTARTS) return answer;
    await wait(MOVED_DELAY_MS * 2 ** attempt);
  }
}

type Contents = {
  composition: string;
  items: { occurrence: string; role: 'group' | 'chapter'; label: { value: string } | null;
    division: 'volume' | 'part' | 'extras' | null; number: number | null }[];
  nextCursor: string | null;
};

export function mainMediaApi(actingSubject: string, main: () => MainClient = browserMainApi): MediaApi {
  const episodes: EpisodeApi = mainEpisodeApi(actingSubject, main);
  const contentsPage = (work: string, query?: { parent?: string; cursor?: string }) =>
    restarted(() => settle(() => main().v1.works({ id: uuidOf(work) }).contents.get({ query: {
      actingSubject, limit: PAGE, ...(query?.parent ? { parent: query.parent } : {}),
      ...(query?.cursor ? { cursor: query.cursor } : {}) } })));

  async function chapterPages(work: string, parent?: string): Promise<Loaded<Contents['items']> | { ok: false; failure: 'missing' }> {
    const items: Contents['items'] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const read = await contentsPage(work, { ...(parent ? { parent } : {}), ...(cursor ? { cursor } : {}) });
      if (!read.ok) return read.failure === 'missing' ? { ok: false, failure: 'missing' } : read;
      const data = read.data as Contents;
      items.push(...data.items);
      if (!data.nextCursor) return { ok: true, data: items };
      cursor = data.nextCursor;
    }
    return { ok: true, data: items };
  }

  return {
    async types(work) {
      const read = await restarted(() => settle(() => main().v1.works({ id: uuidOf(work) }).get({ query: { actingSubject } })));
      if (!read.ok) return read.failure === 'missing' ? { ok: true, data: null } : read;
      return { ok: true, data: read.data.types };
    },
    async volumes(work) {
      const found: { number: number; label: string | null; work: string }[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const read = await restarted(() => settle(() => main().v1.resources({ resource: uuidOf(work) }).parts.get({
          query: { actingSubject, limit: PAGE, ...(after ? { after } : {}) } })));
        if (!read.ok) return read.failure === 'missing' ? { ok: true, data: [] } : read;
        for (const part of read.data.parts) {
          if (part.role !== 'part' || !part.work) continue;
          found.push({ number: found.length + 1, label: part.displayLabel ?? null, work: part.work });
        }
        if (!read.data.next) return { ok: true, data: found };
        after = read.data.next;
      }
      return { ok: true, data: found };
    },
    async chapters(work) {
      const top = await chapterPages(work);
      if (!top.ok) return top.failure === 'missing' ? { ok: true, data: null } : top;
      const opened = await contentsPage(work);
      if (!opened.ok) return opened.failure === 'missing' ? { ok: true, data: null } : opened;
      const structure = (opened.data as Contents).composition;
      const chapters: ChapterRef[] = [];
      let volumeCount = 0;
      for (const item of top.data) {
        if (item.role === 'chapter') {
          chapters.push({ structure, occurrence: item.occurrence, number: item.number ?? chapters.length + 1,
            label: item.label?.value ?? null, volume: null });
          continue;
        }
        if (item.division !== 'volume') continue;
        const nested = await chapterPages(work, item.occurrence);
        if (!nested.ok) return nested;
        volumeCount += 1;
        const volume = { number: item.number ?? volumeCount, label: item.label?.value ?? null };
        let count = 0;
        for (const child of nested.data) {
          if (child.role !== 'chapter') continue;
          count += 1;
          // The chapter's place in this volume, not its number through the whole book.
          chapters.push({ structure, occurrence: child.occurrence, number: count, label: child.label?.value ?? null, volume });
        }
      }
      return { ok: true, data: chapters };
    },
    async routes(work) {
      const found = await episodes.structure(work);
      if (!found.ok) return found;
      if (!found.data) return { ok: true, data: [] };
      const routes: RouteRef[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const read = await restarted(() => settle(() => main().v1.resources({ resource: uuidOf(work) }).parts.get({
          query: { actingSubject, limit: PAGE, ...(after ? { after } : {}) } })));
        if (!read.ok) return read.failure === 'missing' ? { ok: true, data: [] } : read;
        for (const part of read.data.parts) {
          if (part.role !== 'part') continue;
          routes.push({ structure: found.data.structure, occurrence: part.occurrence,
            label: part.displayLabel || `Part ${routes.length + 1}`, required: part.inclusion !== 'optional' && part.inclusion !== 'extra' });
        }
        if (!read.data.next) return { ok: true, data: routes };
        after = read.data.next;
      }
      return { ok: true, data: routes };
    },
    async resume(work) {
      const read = await restarted(() => settle(() => main().v1['reading-positions']({ work: uuidOf(work) }).get({
        query: { actingSubject, position: 'mine', limit: 1 } })));
      if (!read.ok) return read.failure === 'missing' || read.failure === 'unavailable' ? { ok: true, data: null } : read;
      if (read.data.resolved.startsWith('https://')) return { ok: true, data: read.data.resolved };
      return { ok: true, data: read.data.items[0]?.occurrence ?? null };
    },
    progress: part => episodes.progress(part),
    mark: (part, change) => episodes.mark(part, change, { conflict: true }),
  };
}
