import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { commandKey } from '../feed/api.ts';
import { type Loaded, settle } from '../feed/types.ts';
import type { LibraryVisibility, Review, Visibility, YearlyGoal } from './types.ts';

// The browser side of Library. Every command acts as the session's Agent,
// compares and sets against the version the page read, and carries its own
// idempotency key; the BFF adds the bearer token. Views take a `LibraryApi`,
// so stories run the same flows against an in-memory Main. Status changes go
// through the catalogue's reader store, shared with every shelf button.

export interface ReadingDates { startedOn: string | null; finishedOn: string | null }

export interface ReviewDraft { text: string; spoiler: boolean; language: string }

export interface LibraryApi {
  /** Reading dates on Read. A status another tab changed is read again and, if still Read, written once more. */
  setDates(work: string, version: number, dates: ReadingDates): Promise<Loaded<{ version: number }>>;
  /** The reader's Global rating, 1–5, on the Work's current Main Version. */
  rate(work: string, value: number, context: string): Promise<Loaded<{ value: number }>>;
  saveReview(work: string, context: string, draft: ReviewDraft, expectedRevision: string | null):
    Promise<Loaded<{ review: string; revision: string }>>;
  deleteReview(review: string, expectedRevision: string): Promise<Loaded<unknown>>;
  /** Who may see the status shelves. A 409 answers `moved`; `readVisibility` then shows what won. */
  setVisibility(visibility: Visibility, expectedVersion: number): Promise<Loaded<LibraryVisibility>>;
  readVisibility(): Promise<Loaded<LibraryVisibility>>;
  /** Adds Works to the end of a custom shelf; Main may apply it a moment later. */
  addToShelf(shelf: string, works: readonly string[]): Promise<Loaded<unknown>>;
  removeFromShelf(shelf: string, occurrences: readonly string[]): Promise<Loaded<unknown>>;
  createShelf(name: string, disclosure: 'public' | 'private'): Promise<Loaded<{ id: string }>>;
}

const headers = () => ({ headers: { 'idempotency-key': commandKey() } });
const uuid = (iri: string) => iri.slice(-36);
// Main's Collection change takes at most sixteen operations.
const CHANGE_BATCH = 16;

export const saveYearlyGoal = (agent: string, year: number, target: number | null, expectedVersion: number,
  main: () => MainClient = browserMainApi): Promise<Loaded<YearlyGoal>> =>
  settle(() => main().v1.me['reading-goal'].put({ actingSubject: agent, year, target, expectedVersion }, headers()));

export function mainLibraryApi(actingSubject: string, main: () => MainClient = browserMainApi): LibraryApi {
  /** A Collection's current head and root, which a change names. */
  const collectionHead = (shelf: string) => settle(() => main().v1.collections({ id: uuid(shelf) }).get({ query: {
    actingSubject, limit: 1 } }));

  /** Applies operations in Main's batches, each on the head the last one left; a stale head is read again once. */
  async function change(shelf: string, operations: readonly unknown[]): Promise<Loaded<unknown>> {
    for (let offset = 0; offset < operations.length; offset += CHANGE_BATCH) {
      const batch = operations.slice(offset, offset + CHANGE_BATCH);
      let written: Loaded<unknown> | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const head = await collectionHead(shelf);
        if (!head.ok) return head;
        written = await settle(() => main().v1.collections({ id: uuid(shelf) }).changes.post({
          expectedHead: head.data.revision, actingSubject,
          operations: batch as Parameters<ReturnType<MainClient['v1']['collections']>['changes']['post']>[0]['operations'],
        }, headers()));
        if (written.ok || written.failure !== 'moved') break;
      }
      if (written && !written.ok) return written;
    }
    return { ok: true, data: null };
  }

  return {
    async setDates(work, version, dates) {
      const put = (expectedVersion: number) => settle(() => main().v1.works({ id: uuid(work) })['reader-status'].put({
        actingSubject, expectedVersion, status: 'read', ...dates }, headers()));
      let written = await put(version);
      if (!written.ok && written.failure === 'moved') {
        const fresh = await settle(() => main().v1.works({ id: uuid(work) })['reader-state'].get({ query: {
          actingSubject } }));
        if (!fresh.ok) return fresh;
        if (fresh.data.status.status !== 'read') return { ok: false, failure: 'moved' };
        written = await put(fresh.data.status.version);
      }
      return written.ok ? { ok: true, data: { version: written.data.version } } : written;
    },

    async rate(work, value, context) {
      const [state, header] = await Promise.all([
        settle(() => main().v1.works({ id: uuid(work) })['reader-state'].get({ query: { actingSubject } })),
        settle(() => main().v1.works({ id: uuid(work) }).get({ query: { actingSubject } })),
      ]);
      if (!state.ok) return state;
      if (!header.ok) return header;
      const own = state.data.rating.global?.context === context ? state.data.rating.global : null;
      const post = (head: string | null) => settle(() => main().v1['global-rating-observations'].post({
        profile: 'global-rating-standing-observation-v1', context, work, mainVersion: header.data.mainVersion,
        expectedRevisionHead: head, value, actingSubject }, headers()));
      let written = await post(own?.revision ?? null);
      if (!written.ok && written.failure === 'moved') {
        const fresh = await settle(() => main().v1.works({ id: uuid(work) })['reader-state'].get({ query: {
          actingSubject } }));
        if (!fresh.ok) return fresh;
        written = await post(fresh.data.rating.global?.context === context ? fresh.data.rating.global.revision : null);
      }
      return written.ok ? { ok: true, data: { value } } : written;
    },

    async saveReview(work, context, draft, expectedRevision) {
      const written = await settle(() => main().v1.reviews.post({ profile: 'reader-review-command-v1', actingSubject,
        context, target: work, expectedRevision, language: draft.language, text: draft.text, spoiler: draft.spoiler }, headers()));
      return written.ok ? { ok: true, data: { review: written.data.review, revision: written.data.revision } } : written;
    },

    deleteReview: (review, expectedRevision) => settle(() => main().v1.reviews({ id: review }).delete({
      profile: 'reader-review-delete-v1', actingSubject, expectedRevision }, headers())),

    setVisibility: (visibility, expectedVersion) => settle(() => main().v1.agents({ id: uuid(actingSubject) })
      ['library-visibility'].put({ visibility, expectedVersion }, headers())),

    readVisibility: () => settle(() => main().v1.agents({ id: uuid(actingSubject) })['library-visibility'].get()),

    async addToShelf(shelf, works) {
      const head = await collectionHead(shelf);
      if (!head.ok) return head;
      return change(shelf, works.map(target => ({ op: 'insert', parent: head.data.structure, position: 'last',
        role: 'member', target })));
    },

    removeFromShelf: (shelf, occurrences) => change(shelf, occurrences.map(occurrence => ({ op: 'remove',
      occurrence }))),

    async createShelf(name, disclosure) {
      const collection = `https://rezics.com/id/${crypto.randomUUID()}`;
      const written = await settle(() => main().v1.collections.post({ collection, name, disclosure, actingSubject },
        headers()));
      return written.ok ? { ok: true, data: { id: collection } } : written;
    },
  };
}

/** A review as the editor keeps it: the saved text and the revision the next save compares against. */
export type SavedReview = Pick<Review, 'id' | 'revision' | 'text' | 'spoiler' | 'language' | 'rating'>;
