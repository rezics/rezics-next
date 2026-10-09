import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { commandKey } from '../feed/api.ts';
import { failureOf, type Loaded, settle, uuidOf } from '../feed/types.ts';

// The browser side of episode progress. A series Structure places its episodes as occurrences, with
// specials in a group of their own: Main lists them page by page (`/v1/compositions/{id}`) and keeps
// the reader's own completion per occurrence (`.../occurrences/{id}/progress`). Nothing here stores
// progress: every write is Main's compare-and-set, and a second device reads the same rows.

/** A placement in a series Structure that stands for an episode. */
export interface EpisodePart { occurrence: string; label: string | null }
/** A group of episodes set apart from the main run, such as Specials. */
export interface EpisodeGroup { occurrence: string; label: string | null }
/** One page of a Structure parent, in Main's order. */
export interface StructurePage { parts: EpisodePart[]; groups: EpisodeGroup[]; next: string | null }

/** Where an occurrence lives, which is all progress needs to name it. */
export interface EpisodeRef { structure: string; occurrence: string }
export interface EpisodeProgress { completed: boolean; position: string | null; version: number }

/**
 * Another device wrote this occurrence first. `submitted` is the change this device still means to
 * make; nothing is merged until the reader chooses.
 */
export interface ProgressStale {
  ok: false;
  failure: 'stale';
  current: EpisodeProgress;
  submitted: { completed: boolean; position: string | null };
}

export interface EpisodeApi {
  /**
   * The Work's series Structure and whether its root places Works (the series panel's own volumes)
   * rather than episodes. Null when the Work has no such Structure.
   */
  structure(work: string): Promise<Loaded<{ structure: string; placesWorks: boolean } | null>>;
  /** A page of the Structure's root, or of one group with `parent`; `after` continues it. */
  page(structure: string, query?: { parent?: string; after?: string }): Promise<Loaded<StructurePage>>;
  /**
   * The furthest occurrence this reader has completed, from the progress order index.
   * Null when they have not started. A read that does not answer is a failure.
   */
  resume(work: string): Promise<Loaded<string | null>>;
  progress(episode: EpisodeRef): Promise<Loaded<EpisodeProgress>>;
  /**
   * Sets one occurrence's completion. Without `conflict`, a write another device got to first is
   * read again and the same change applied once more. With `conflict`, that answer is returned
   * instead, so the reader can keep their change or take the other device's.
   */
  mark(episode: EpisodeRef, change: { completed: boolean; position?: string | null },
    options?: { conflict?: boolean }): Promise<Loaded<EpisodeProgress> | ProgressStale>;
}

/**
 * Main bounds a Work read at 20 items and 160 graph calls, and each episode's target is disclosed
 * with calls of its own, so a Structure is read 20 at a time.
 */
export const EPISODE_PAGE = 20;
/** A read Main asked to restart (its graph moved under it) or could not answer is tried this many more times, waiting twice as long after each. */
const MOVED_RESTARTS = 4;
const MOVED_DELAY_MS = 250;
/** Attempts at a write that another device, or the graph moving, got in front of. */
const MARK_ATTEMPTS = 5;
/** Times one write is sent when Main cannot answer it. */
const SEND_ATTEMPTS = 3;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

async function restarted<T>(read: () => Promise<Loaded<T>>): Promise<Loaded<T>> {
  for (let attempt = 0; ; attempt++) {
    const answer = await read();
    if (answer.ok || answer.failure !== 'moved' && answer.failure !== 'unavailable' || attempt === MOVED_RESTARTS) return answer;
    await wait(MOVED_DELAY_MS * 2 ** attempt);
  }
}

export function mainEpisodeApi(actingSubject: string, main: () => MainClient = browserMainApi): EpisodeApi {
  const progress = (episode: EpisodeRef) =>
    main().v1.compositions({ id: uuidOf(episode.structure) }).occurrences({ occurrence: uuidOf(episode.occurrence) }).progress;
  const read = (episode: EpisodeRef) => restarted(() => settle(() => progress(episode).get({ query: { actingSubject } })));
  return {
    async structure(work) {
      const parts = await restarted(() => settle(() => main().v1.resources({ resource: uuidOf(work) }).parts.get({
        query: { actingSubject, limit: EPISODE_PAGE } })));
      // A Work with no series Structure is no failure: it simply has no episodes to track.
      if (!parts.ok) return parts.failure === 'missing' ? { ok: true, data: null } : parts;
      return { ok: true, data: { structure: parts.data.structure, placesWorks: parts.data.parts.some(part => part.role === 'part') } };
    },
    async page(structure, { parent, after } = {}) {
      const page = await restarted(() => settle(() => main().v1.compositions({ id: uuidOf(structure) }).get({
        query: { actingSubject, limit: EPISODE_PAGE, ...(parent ? { parent } : {}), ...(after ? { after } : {}) } })));
      if (!page.ok) return page;
      const label = (item: (typeof page.data.occurrences)[number]) =>
        (item.qualifier?.type === 'work-part' ? item.qualifier.displayLabel : null) ?? item.labels[0]?.value ?? null;
      return { ok: true, data: { next: page.data.next,
        parts: page.data.occurrences.filter(item => item.role === 'part' && item.target)
          .map(item => ({ occurrence: item.occurrence, label: label(item) })),
        groups: page.data.occurrences.filter(item => item.role === 'group')
          .map(item => ({ occurrence: item.occurrence, label: item.labels[0]?.value ?? null })) } };
    },
    async resume(work) {
      const read = await restarted(() => settle(() => main().v1['reading-positions']({ work: uuidOf(work) }).get({
        query: { actingSubject, position: 'mine', limit: 1 } })));
      if (!read.ok) return read;
      const page = read.data as { scope?: string; resolved?: string; items?: { occurrence?: string }[] };
      const named = page.scope === 'resume' || page.resolved?.startsWith('https://') === true;
      if (!named) return { ok: true, data: null };
      return { ok: true, data: page.items?.[0]?.occurrence ?? page.resolved ?? null };
    },
    progress: read,
    async mark(episode, change, options) {
      for (let attempt = 0; attempt < MARK_ATTEMPTS; attempt++) {
        const current = await read(episode);
        if (!current.ok) return current;
        const body = { actingSubject, expectedVersion: current.data.version, completed: change.completed,
          position: change.position === undefined ? current.data.position : change.position };
        // One key per intent: a write Main could not answer is sent again as the same command, and replays.
        const key = commandKey();
        for (let tries = 0; tries < SEND_ATTEMPTS; tries++) {
          try {
            const { data, error } = await progress(episode).put(body, { headers: { 'idempotency-key': key } });
            if (!error) return data ? { ok: true, data } : { ok: false, failure: 'unavailable' };
            if (error.status === 409) {
              const code = (error.value as { code?: string } | null)?.code;
              // Main moving under the write asks for a pause; another device's write asks to read again.
              if (code === 'read_basis_changed') await wait(MOVED_DELAY_MS * 2 ** attempt);
              else if (options?.conflict && code === 'stale_progress') {
                const again = await read(episode);
                if (!again.ok) return again;
                return { ok: false, failure: 'stale', current: again.data,
                  submitted: { completed: change.completed, position: body.position } };
              }
              break;
            }
            if (error.status < 500 || tries === SEND_ATTEMPTS - 1) return { ok: false, failure: failureOf(error.status, error.value) };
          } catch {
            if (tries === SEND_ATTEMPTS - 1) return { ok: false, failure: 'unavailable' };
          }
          await wait(MOVED_DELAY_MS * 2 ** tries);
        }
      }
      return { ok: false, failure: 'moved' };
    },
  };
}
