import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { commandKey } from '../feed/api.ts';
import { failureOf, type Loaded, type ReadFailure, settle, uuidOf } from '../feed/types.ts';
import { type EpisodeApi, mainEpisodeApi } from './episode-api.ts';
import { type MediaApi, mainMediaApi } from './media-api.ts';
import type { EditionChoice, EditionPreference, Editions, ProgressSummary, Relations, Session, SessionChanges,
  SessionPage } from './types.ts';

// The browser side of tracking. Every call acts as the session's Agent and the BFF adds the bearer
// token. Writes compare and set: a stale version is answered with Main's current state and the
// change that was refused, so the reader sees both and chooses (nothing is merged here). Views
// take a `TrackingApi`, so stories and tests run the same flows against an in-memory Main.

/** A write's answer: the state Main now holds, or why not. `stale` carries both sides of the conflict. */
export type Write<T, Submitted = never> =
  | { ok: true; data: T }
  | { ok: false; failure: ReadFailure }
  | { ok: false; failure: 'stale'; current: T; submitted: Submitted };

export type StaleChange = SessionChanges & { expectedVersion: number };
export type AttemptWrite = Write<Session, StaleChange>;
export type PreferenceWrite = Write<EditionPreference | null, EditionChoice>;

export interface StartInput {
  state: 'planned' | 'active' | 'finished';
  startedOn?: string | null;
  finishedOn?: string | null;
  addSelections?: SessionChanges['addSelections'];
}

export interface TrackingApi {
  /** The Work's attempts, newest first; `next` continues them. */
  sessions(work: string, cursor?: string): Promise<Loaded<{ items: Session[]; next: string | null }>>;
  start(work: string, input: StartInput): Promise<AttemptWrite>;
  change(session: string, expectedVersion: number, changes: SessionChanges): Promise<AttemptWrite>;
  /**
   * One page of the Work's realizations and releases. A continuation reads only the lists whose
   * cursors it carries, so a finished list is not fetched again.
   */
  editions(work: string, page?: EditionPageQuery): Promise<Loaded<Editions>>;
  /** Main's series progress for a Work's composition, in the chosen language (the preference's when unset). */
  series(resource: string, language?: string): Promise<Loaded<ProgressSummary>>;
  relations(resource: string): Promise<Loaded<Relations>>;
  /** The definition Main holds for a relation key, to tell which entries are that kind. */
  definition(key: string): Promise<Loaded<{ definition: string }>>;
  preference(work: string): Promise<Loaded<EditionPreference | null>>;
  setPreference(work: string, expectedVersion: number, choice: EditionChoice): Promise<PreferenceWrite>;
  /** Progress through the episodes or chapters a series Structure places; absent where a surface has none. */
  episodes?: EpisodeApi;
  /** Chapters, volumes and games on the same occurrence progress. Absent where a surface has none. */
  media?: MediaApi;
}

/** The page size Main allows for a Work's realizations and releases. */
const EDITION_PAGE = 20;

/** Cursors for the next page of each list. Omit a list to leave it unread. */
export interface EditionPageQuery { realizations?: string; releases?: string }

/** Which lists a continuation read, so an unread list keeps the editions and cursor it already has. */
export interface EditionPageRequest { realizations: boolean; releases: boolean }

function mergeById<T extends { id: string }>(current: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  // Keep the order already shown, then the new page's order, dropping an identity that was already listed.
  return [...current, ...page.filter(item => !seen.has(item.id))];
}

/** Append one page of each requested list. An unrequested list stays as it was, including its cursor. */
export function appendEditionPage(current: Editions, page: Editions, requested: EditionPageRequest): Editions {
  const realizations = requested.realizations ? mergeById(current.realizations, page.realizations) : current.realizations;
  const releases = requested.releases ? mergeById(current.releases, page.releases) : current.releases;
  const realizationsCursor = requested.realizations ? page.realizationsCursor ?? null : current.realizationsCursor ?? null;
  const releasesCursor = requested.releases ? page.releasesCursor ?? null : current.releasesCursor ?? null;
  return { realizations, releases, realizationsCursor, releasesCursor, more: Boolean(realizationsCursor || releasesCursor) };
}

const RELATION_PAGES = 5;
/** A read Main asked to restart is restarted this many times, waiting twice as long after each. */
const MOVED_RESTARTS = 4;
const MOVED_DELAY_MS = 250;
const headers = () => ({ headers: { 'idempotency-key': commandKey() } });

interface Failed { status: number; value: unknown }
type Answer<T> = { data: T | null; error: Failed | null };

/** The conflict body Main answers when an attempt changed first: its state and the refused change. */
function stale(error: Failed): { current: Session; submitted: StaleChange } | null {
  const body = error.value as { code?: string; current?: Session; submitted?: StaleChange } | null;
  return body?.code === 'stale_session' && body.current && body.submitted
    ? { current: body.current, submitted: body.submitted } : null;
}

export function mainTrackingApi(actingSubject: string, main: () => MainClient = browserMainApi): TrackingApi {
  async function attempt(call: () => Promise<Answer<Session | Response>>): Promise<AttemptWrite> {
    try {
      const { data, error } = await call();
      if (error) {
        const conflict = error.status === 409 ? stale(error) : null;
        return conflict ? { ok: false, failure: 'stale', ...conflict } : { ok: false, failure: failureOf(error.status) };
      }
      return data && 'id' in data ? { ok: true, data } : { ok: false, failure: 'unavailable' };
    } catch {
      return { ok: false, failure: 'unavailable' };
    }
  }

  async function relationPages(resource: string): Promise<Loaded<Relations>> {
    // Follow Main's pages up to a bound; a Work with more relations than that offers no more than it has read.
    let all: Relations | null = null;
    for (let page = 0, after: string | undefined; page < RELATION_PAGES; page++) {
      const read = await settle(() => main().v1.resources({ resource: uuidOf(resource) }).relations.get({ query: {
        actingSubject, limit: 20, ...(after ? { after } : {}) } }));
      if (!read.ok) return all && read.failure !== 'moved' ? { ok: true, data: all } : read;
      all = all ? { ...read.data, items: [...all.items, ...read.data.items] } : read.data;
      if (!read.data.next) break;
      after = read.data.next;
    }
    return all ? { ok: true, data: all } : { ok: false, failure: 'unavailable' };
  }

  return {
    episodes: mainEpisodeApi(actingSubject, main),
    media: mainMediaApi(actingSubject, main),
    sessions: (work, cursor) => settle<SessionPage>(() => main().v1.me.sessions.get({ query: { actingSubject, target: work,
      limit: 50, ...(cursor ? { cursor } : {}) } })).then(read => (read.ok
      ? { ok: true, data: { items: read.data.items, next: read.data.nextCursor } } : read)),
    start: (work, input) => attempt(() => main().v1.me.sessions.post({ actingSubject, target: work, expectedVersion: 0,
      ...input }, headers())),
    change: (session, expectedVersion, changes) => attempt(() => main().v1.me.sessions({ id: uuidOf(session) }).patch({
      actingSubject, expectedVersion, ...changes }, headers())),
    async editions(work, page) {
      const id = uuidOf(work);
      // The first read asks for both lists. A continuation asks only for the lists that still have a cursor.
      const first = page === undefined;
      const readRealizations = first || Boolean(page.realizations);
      const readReleases = first || Boolean(page.releases);
      const [realizations, releases] = await Promise.all([
        readRealizations ? settle(() => main().v1.works({ id }).realizations.get({ query: { actingSubject, limit: EDITION_PAGE,
          ...(page?.realizations ? { cursor: page.realizations } : {}) } }))
          : Promise.resolve({ ok: true as const, data: { items: [], nextCursor: null } }),
        readReleases ? settle(() => main().v1.works({ id }).releases.get({ query: { actingSubject, limit: EDITION_PAGE,
          ...(page?.releases ? { cursor: page.releases } : {}) } }))
          : Promise.resolve({ ok: true as const, data: { items: [], nextCursor: null } }),
      ]);
      if (!realizations.ok) return realizations;
      if (!releases.ok) return releases;
      const realizationsCursor = readRealizations ? realizations.data.nextCursor : null;
      const releasesCursor = readReleases ? releases.data.nextCursor : null;
      return { ok: true, data: { realizations: realizations.data.items, releases: releases.data.items,
        realizationsCursor, releasesCursor, more: Boolean(realizationsCursor || releasesCursor) } };
    },
    series: (resource, language) => settle(() => main().v1.me['progress-summaries']({ resource: uuidOf(resource) }).get({
      query: { actingSubject, ...(language ? { language } : {}) } })),
    async relations(resource) {
      // Main answers 409 when its graph moved under the read and asks for the read to restart from its first page.
      for (let attempt = 0; ; attempt++) {
        const read = await relationPages(resource);
        if (read.ok || read.failure !== 'moved' || attempt === MOVED_RESTARTS) return read;
        await new Promise(done => setTimeout(done, MOVED_DELAY_MS * 2 ** attempt));
      }
    },
    definition: key => settle(() => main().v1.lexicon.definitions({ key }).get({ query: { actingSubject } })),
    preference: work => settle(() => main().v1.me['edition-preferences']({ work: uuidOf(work) }).get({
      query: { actingSubject } })),
    async setPreference(work, expectedVersion, choice) {
      try {
        const { data, error } = await main().v1.me['edition-preferences']({ work: uuidOf(work) }).put({
          actingSubject, expectedVersion, ...choice }, headers());
        if (error) {
          const body = error.value as { code?: string; current?: EditionPreference | null } | null;
          return error.status === 409 && body?.code === 'stale_edition_preference' && body.current !== undefined
            ? { ok: false, failure: 'stale', current: body.current, submitted: choice }
            : { ok: false, failure: failureOf(error.status) };
        }
        return { ok: true, data: data };
      } catch {
        return { ok: false, failure: 'unavailable' };
      }
    },
  };
}
