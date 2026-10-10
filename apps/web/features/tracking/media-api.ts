import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { commandKey } from '../feed/api.ts';
import { failedRead, failureOf, isOfflineError, type Loaded, type ReadFailure, settle, uuidOf } from '../feed/types.ts';
import { type EpisodeProgress, type ProgressStale, mainEpisodeApi } from './episode-api.ts';
import { resumeName, type ChapterRef, type Place, type RouteRef } from './media.ts';

// The same occurrence progress episodes use. A manga is placed by one resume read and one page of
// the Work's positions; a game by one page of its parts and one page of completed occurrences.
// Nothing here walks a series, and a read that fails is a failure rather than an empty place.

export interface PositionPage { items: Place[]; next: string | null }

/** Last read, and the chapter after it when that same resume read, or its one neighbour lookup, names it. */
export interface ChapterStanding {
  last: Place | null;
  next: Place | null;
  /** The neighbour lookup reached the end of the order, so there is no later chapter. */
  caughtUp: boolean;
  /** The opening page, when the resume read was that page. Null once the reader has a place. */
  opened: PositionPage | null;
}

export interface PartPage { items: RouteRef[]; next: string | null }

/** Completed occurrences from one page. `complete` is true when the page is the whole list. */
export interface CompletionPage { occurrences: string[]; next: string | null; complete: boolean }

/** Playing or reading is `started`: one mark, named for the Work. */
export type WorkStanding = 'not-started' | 'started' | 'completed' | 'dropped';
export interface WorkMark { standing: WorkStanding; version: number }
export interface WorkStale { ok: false; failure: 'stale'; current: WorkMark; submitted: WorkStanding }

export interface MediaApi {
  /** The Work's types, so the served registry can name its kind. Null when the Work is missing. */
  types(work: string): Promise<Loaded<string[] | null>>;
  /** The first page of volumes this Work places. Empty when it places none. */
  volumes(work: string): Promise<Loaded<{ number: number; label: string | null; work: string }[]>>;
  /** The first page of the Book's own chapters. Null when the Work is not a Book. */
  chapters(work: string): Promise<Loaded<ChapterRef[] | null>>;
  /** One page of the Work's parts. Required parts are the game; the others are routes. */
  routes(work: string, after?: string): Promise<Loaded<PartPage>>;
  /** One resume read, plus the neighbour of that chapter when the reader has one. */
  standing(work: string): Promise<Loaded<ChapterStanding>>;
  /** One page of the Work's positions. `cursor` is the previous page's next. */
  positions(work: string, cursor?: string): Promise<Loaded<PositionPage>>;
  /** One page of occurrences this reader has completed. */
  completions(structure: string, cursor?: string): Promise<Loaded<CompletionPage>>;
  progress(part: { structure: string; occurrence: string }): Promise<Loaded<EpisodeProgress>>;
  /** Writes one occurrence and, when another device wrote first, returns both sides. */
  mark(part: { structure: string; occurrence: string }, change: { completed: boolean; position?: string | null }):
    Promise<Loaded<EpisodeProgress> | ProgressStale>;
  /** Whether progress is kept on parts. Main's answer, including an empty composition. */
  workParts(work: string): Promise<Loaded<boolean>>;
  /** The whole Work, when it has no parts. A Work with parts is `has-parts`, not a retry. */
  workStanding(work: string): Promise<Loaded<WorkMark> | { ok: false; failure: 'has-parts' }>;
  /** Writes that mark. A stale version returns both sides and does not merge them. */
  markWork(work: string, standing: WorkStanding): Promise<Loaded<WorkMark> | WorkStale | { ok: false; failure: 'has-parts' }>;
}

/** `work_has_parts` names a Work whose progress lives on its parts. Other 409s are a moved graph or a stale write. */
export function workProgressConflict(status: number, body: unknown): 'parts' | 'other' | null {
  if (status !== 409) return null;
  const code = body && typeof body === 'object' && 'code' in body ? (body as { code?: unknown }).code : undefined;
  return code === 'work_has_parts' ? 'parts' : 'other';
}

const PAGE = 20;
const MOVED_RESTARTS = 4;
const MOVED_DELAY_MS = 250;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

type WorkProgressBody = { parts?: boolean; standing?: WorkStanding; version?: number };
type WorkProgressAnswer = { data: WorkProgressBody | null; error: { status: number; value: unknown } | null };

/** One progress read. A Work with parts answers immediately. A moved graph is the only 409 that restarts. */
async function readWorkProgress(get: () => Promise<WorkProgressAnswer>): Promise<
  | { ok: true; parts: false; mark: WorkMark }
  | { ok: true; parts: true }
  | { ok: false; failure: ReadFailure }
> {
  for (let attempt = 0; ; attempt++) {
    let answer: WorkProgressAnswer;
    try { answer = await get(); }
    catch (error) {
      const failure = isOfflineError(error) ? 'offline' as const : 'unavailable' as const;
      if (failure === 'offline' || attempt === MOVED_RESTARTS) return { ok: false, failure };
      await wait(MOVED_DELAY_MS * 2 ** attempt);
      continue;
    }
    if (answer.error && workProgressConflict(answer.error.status, answer.error.value) === 'parts') {
      return { ok: true, parts: true };
    }
    if (answer.error) {
      const failure = failureOf(answer.error.status, answer.error.value);
      if (failure !== 'moved' && failure !== 'unavailable' || attempt === MOVED_RESTARTS) {
        return failedRead(failure, answer.error.value);
      }
      await wait(MOVED_DELAY_MS * 2 ** attempt);
      continue;
    }
    const data = answer.data;
    if (data?.parts === true) return { ok: true, parts: true };
    if (data?.standing && typeof data.version === 'number') {
      return { ok: true, parts: false, mark: { standing: data.standing, version: data.version } };
    }
    if (attempt === MOVED_RESTARTS) return { ok: false, failure: 'unavailable' };
    await wait(MOVED_DELAY_MS * 2 ** attempt);
  }
}

async function restarted<T>(read: () => Promise<Loaded<T>>): Promise<Loaded<T>> {
  for (let attempt = 0; ; attempt++) {
    const answer = await read();
    if (answer.ok || answer.failure !== 'moved' && answer.failure !== 'unavailable' || attempt === MOVED_RESTARTS) return answer;
    await wait(MOVED_DELAY_MS * 2 ** attempt);
  }
}

type PositionItem = { occurrence: string; structure: string; role: 'part' | 'chapter' | 'group';
  displayLabel?: string; labels?: { value: string }[] };

const placeOf = (item: PositionItem): Place => ({
  structure: item.structure, occurrence: item.occurrence, label: resumeName(item) ?? '',
});

const chaptersOf = (items: readonly PositionItem[]): Place[] =>
  items.filter(item => item.role === 'chapter').map(placeOf);

type Contents = {
  composition: string;
  items: { occurrence: string; role: 'group' | 'chapter'; label: { value: string } | null; number: number | null }[];
  nextCursor: string | null;
};

export function mainMediaApi(actingSubject: string, main: () => MainClient = browserMainApi): MediaApi {
  const episodes = mainEpisodeApi(actingSubject, main);
  const positionsOf = (work: string, query: { position: 'mine' | 'start'; limit?: number; cursor?: string; around?: string }) =>
    restarted(() => settle(() => main().v1['reading-positions']({ work: uuidOf(work) }).get({ query: { actingSubject, ...query } })));

  return {
    async types(work) {
      const read = await restarted(() => settle(() => main().v1.works({ id: uuidOf(work) }).get({ query: { actingSubject } })));
      if (!read.ok) return read.failure === 'missing' ? { ok: true, data: null } : read;
      return { ok: true, data: read.data.types };
    },
    async volumes(work) {
      const read = await restarted(() => settle(() => main().v1.resources({ resource: uuidOf(work) }).parts.get({
        query: { actingSubject, limit: PAGE } })));
      if (!read.ok) return read.failure === 'missing' ? { ok: true, data: [] } : read;
      const found = read.data.parts.flatMap(part => part.role === 'part' && part.work
        ? [{ number: 0, label: part.displayLabel ?? null, work: part.work }] : []);
      return { ok: true, data: found.map((volume, index) => ({ ...volume, number: index + 1 })) };
    },
    async chapters(work) {
      const read = await restarted(() => settle(() => main().v1.works({ id: uuidOf(work) }).contents.get({
        query: { actingSubject, limit: PAGE } })));
      if (!read.ok) return read.failure === 'missing' ? { ok: true, data: null } : read;
      const data = read.data as Contents;
      const chapters: ChapterRef[] = data.items.flatMap(item => item.role === 'chapter'
        ? [{ structure: data.composition, occurrence: item.occurrence, number: item.number ?? 0,
          label: item.label?.value ?? null, volume: null }] : []);
      return { ok: true, data: chapters };
    },
    async routes(work, after) {
      const read = await restarted(() => settle(() => main().v1.resources({ resource: uuidOf(work) }).parts.get({
        query: { actingSubject, limit: PAGE, ...(after ? { after } : {}) } })));
      if (!read.ok) return read.failure === 'missing' ? { ok: true, data: { items: [], next: null } } : read;
      const items = read.data.parts.flatMap(part => part.role === 'part' ? [{
        structure: read.data.structure, occurrence: part.occurrence, label: part.displayLabel || '',
        required: part.inclusion !== 'optional' && part.inclusion !== 'extra',
      }] : []);
      return { ok: true, data: { items, next: read.data.next } };
    },
    async standing(work) {
      const read = await positionsOf(work, { position: 'mine', limit: PAGE });
      if (!read.ok) return read;
      const resumed = read.data.scope === 'resume' || read.data.resolved.startsWith('https://');
      if (!resumed) {
        const items = chaptersOf(read.data.items);
        return { ok: true, data: { last: null, next: items[0] ?? null, caughtUp: items.length === 0 && !read.data.nextCursor,
          opened: { items, next: read.data.nextCursor } } };
      }
      const item = read.data.items[0];
      if (!item) return { ok: false, failure: 'unavailable' };
      const last = placeOf(item);
      const around = await positionsOf(work, { position: 'mine', around: last.occurrence });
      if (!around.ok) return around;
      const step = around.data.neighbours?.next;
      const next = step?.status === 'found'
        ? chaptersOf(around.data.items).find(place => place.occurrence === step.occurrence) ?? null : null;
      return { ok: true, data: { last, next, caughtUp: step?.status === 'none', opened: null } };
    },
    async positions(work, cursor) {
      const read = await positionsOf(work, { position: 'start', limit: PAGE, ...(cursor ? { cursor } : {}) });
      if (!read.ok) return read;
      return { ok: true, data: { items: chaptersOf(read.data.items), next: read.data.nextCursor } };
    },
    async completions(structure, cursor) {
      const read = await restarted(() => settle(() => main().v1.compositions({ id: uuidOf(structure) }).progress.get({
        query: { actingSubject, limit: PAGE, ...(cursor ? { cursor } : {}) } })));
      if (!read.ok) return read;
      return { ok: true, data: { occurrences: read.data.items.map(item => item.occurrence),
        next: read.data.nextCursor, complete: read.data.complete } };
    },
    progress: part => episodes.progress(part),
    mark: (part, change) => episodes.mark(part, change, { conflict: true }),
    async workParts(work) {
      const read = await readWorkProgress(() => main().v1.works({ id: uuidOf(work) }).progress.get({ query: { actingSubject } }));
      return read.ok ? { ok: true, data: read.parts } : read;
    },
    async workStanding(work) {
      const read = await readWorkProgress(() => main().v1.works({ id: uuidOf(work) }).progress.get({ query: { actingSubject } }));
      if (!read.ok) return read;
      return read.parts ? { ok: false, failure: 'has-parts' } : { ok: true, data: read.mark };
    },
    async markWork(work, standing) {
      const progress = () => main().v1.works({ id: uuidOf(work) }).progress;
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await readWorkProgress(() => progress().get({ query: { actingSubject } }));
        if (!current.ok) return current;
        if (current.parts) return { ok: false, failure: 'has-parts' };
        const key = commandKey();
        for (let tries = 0; tries < 3; tries++) {
          try {
            const { data, error } = await progress().put({ actingSubject, expectedVersion: current.mark.version, standing },
              { headers: { 'idempotency-key': key } });
            if (!error) return data ? { ok: true, data } : { ok: false, failure: 'unavailable' };
            if (error.status === 409) {
              if (workProgressConflict(error.status, error.value) === 'parts') return { ok: false, failure: 'has-parts' };
              const code = (error.value as { code?: string } | null)?.code;
              if (code === 'read_basis_changed') { await wait(MOVED_DELAY_MS * 2 ** attempt); break; }
              if (code === 'stale_progress') {
                const again = await readWorkProgress(() => progress().get({ query: { actingSubject } }));
                if (!again.ok) return again;
                if (again.parts) return { ok: false, failure: 'has-parts' };
                return { ok: false, failure: 'stale', current: again.mark, submitted: standing };
              }
              break;
            }
            if (error.status < 500 || tries === 2) return { ok: false, failure: failureOf(error.status, error.value) };
          } catch {
            if (tries === 2) return { ok: false, failure: 'unavailable' };
          }
          await wait(MOVED_DELAY_MS * 2 ** tries);
        }
      }
      return { ok: false, failure: 'moved' };
    },
  };
}
