import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { commandKey } from '../feed/api.ts';
import { failureOf, type Loaded, type ReadFailure, settle, uuidOf } from '../feed/types.ts';
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
  editions(work: string): Promise<Loaded<Editions>>;
  /** Main's series progress for a Work's composition, in the chosen language (the preference's when unset). */
  series(resource: string, language?: string): Promise<Loaded<ProgressSummary>>;
  relations(resource: string): Promise<Loaded<Relations>>;
  /** The definition Main holds for a relation key, to tell which entries are that kind. */
  definition(key: string): Promise<Loaded<{ definition: string }>>;
  preference(work: string): Promise<Loaded<EditionPreference | null>>;
  setPreference(work: string, expectedVersion: number, choice: EditionChoice): Promise<PreferenceWrite>;
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
    sessions: (work, cursor) => settle<SessionPage>(() => main().v1.me.sessions.get({ query: { actingSubject, target: work,
      limit: 50, ...(cursor ? { cursor } : {}) } })).then(read => (read.ok
      ? { ok: true, data: { items: read.data.items, next: read.data.nextCursor } } : read)),
    start: (work, input) => attempt(() => main().v1.me.sessions.post({ actingSubject, target: work, expectedVersion: 0,
      ...input }, headers())),
    change: (session, expectedVersion, changes) => attempt(() => main().v1.me.sessions({ id: uuidOf(session) }).patch({
      actingSubject, expectedVersion, ...changes }, headers())),
    async editions(work) {
      const id = uuidOf(work);
      const [realizations, releases] = await Promise.all([
        settle(() => main().v1.works({ id }).realizations.get({ query: { actingSubject, limit: 20 } })),
        settle(() => main().v1.works({ id }).releases.get({ query: { actingSubject, limit: 20 } }))]);
      if (!realizations.ok) return realizations;
      if (!releases.ok) return releases;
      return { ok: true, data: { realizations: realizations.data.items, releases: releases.data.items,
        more: Boolean(realizations.data.nextCursor || releases.data.nextCursor) } };
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
