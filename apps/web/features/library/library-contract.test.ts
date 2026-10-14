import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { answerPersonas } from '../../../../scripts/api/answer-record.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { loadBooksLibrary, readShelfView } from './books-library-recorded-page.ts';
import { mainLibraryApi } from './api.ts';
import { libraryContractFixture, type LibraryMedium } from './library-contract-fixtures.ts';
import { mainImportApi } from './import-api.ts';
import { mainExportApi } from '../library-backup/export-api.ts';
import { collectExport, collectedRows } from '../library-backup/export-job.ts';
import { memoryExportStore } from '../library-backup/export-store.ts';

const proofRequests: { medium: LibraryMedium; requests: ReturnType<typeof libraryContractFixture>['calls'] }[] = [];
const contractFixture: typeof libraryContractFixture = (...args) => {
  const fixture = libraryContractFixture(...args);
  proofRequests.push({ medium: args[0], requests: fixture.calls });
  return fixture;
};
afterAll(() => {
  mkdirSync('.temp/goal', { recursive: true });
  writeFileSync('.temp/goal/library-prove-requests.json', JSON.stringify({ recorded: false, states: proofRequests }, null, 2));
});

const load = (fixture: ReturnType<typeof libraryContractFixture>) => loadBooksLibrary(fixture.reader,
  { state: fixture.state, locale: 'en', year: 2026, first: fixture.state.shelf.kind === 'all' });

for (const medium of ['books', 'recipes', 'games', 'visual-novels'] as LibraryMedium[]) {
  for (const persona of answerPersonas) {
    test(`${medium}: ${persona} visits only their own Library through the production reader`, async () => {
      const fixture = contractFixture(medium, 'populated', persona);
      const loaded = await load(fixture);
      if (persona === 'visitor') {
        expect(loaded.overview).toEqual({ ok: false, failure: 'sign-in' });
        expect(loaded.view).toEqual({ ok: false, failure: 'sign-in' });
        expect(loaded.reading).toEqual([]);
        expect(fixture.calls).toEqual([]);
        return;
      }
      expect(loaded.overview.ok && loaded.overview.data.agent).toBe(fixture.actor);
      expect(loaded.view.ok).toBe(true);
      if (!loaded.view.ok) return;
      expect(loaded.view.data.rows).toHaveLength(2 - Number(medium === 'visual-novels'));
      expect(fixture.calls.filter(call => call.path.includes('actingSubject=')))
        .not.toHaveLength(0);
      for (const call of fixture.calls) {
        const actor = new URL(call.path, 'https://contract.invalid').searchParams.get('actingSubject');
        if (actor) expect(actor).toBe(fixture.actor);
      }
      const foreign = 'https://rezics.com/id/ffffffff-ffff-4fff-8fff-ffffffffffff';
      const denied = await fixture.main.v1.me.shelves.get({ query: { actingSubject: foreign, limit: 20 } });
      expect(denied.error?.status).toBe(403);
      const work = loaded.view.data.rows[0]!.work.id;
      const progress = await mainTrackingApi(foreign, () => fixture.main).media!.markWork(work, 'completed');
      expect(progress).toEqual({ ok: false, failure: 'sign-in' });
      expect(fixture.marks.get(work)).toMatchObject({ standing: 'not-started', version: 0 });
    });
  }
}

test('repeated recipes render both occurrences, batch one Work read, and remove only the chosen occurrence', async () => {
  const fixture = contractFixture('recipes', 'populated', 'owner');
  const loaded = await load(fixture);
  expect(loaded.view.ok).toBe(true);
  if (!loaded.view.ok) return;
  const rows = loaded.view.data.rows;
  expect(rows[0]!.work.id).toBe(rows[1]!.work.id);
  expect(rows[0]!.occurrence).not.toBe(rows[1]!.occurrence);
  const batch = fixture.calls.filter(call => call.path.startsWith('/v1/me/work-states'));
  expect(batch).toHaveLength(1);
  expect(new URL(batch[0]!.path, 'https://contract.invalid').searchParams.get('works')).toBe(rows[0]!.work.id);
  expect(await mainLibraryApi(fixture.actor, () => fixture.main).removeFromShelf(fixture.recipeCollection!.collection,
    [rows[1]!.occurrence!])).toMatchObject({ ok: true });
  const next = await readShelfView(fixture.reader, fixture.state, 'en');
  expect(next.ok && next.data.rows.map(row => row.occurrence)).toEqual([rows[0]!.occurrence]);
});

test('game progress and replay leave the Library intent shelf and its version intact', async () => {
  const fixture = contractFixture('games', 'replay');
  const loaded = await load(fixture);
  if (!loaded.view.ok) throw new Error('Library did not load');
  const work = loaded.view.data.rows[0]!.work.id;
  const store = createReaderStore({ actingSubject: fixture.actor, main: () => fixture.main, seed: loaded.view.data.seed });
  const intent = store.stateOf(work);
  const saved = await store.tracking!.media!.markWork(work, 'completed');
  expect(saved).toMatchObject({ ok: true, data: { standing: 'completed', replayed: true } });
  expect(store.stateOf(work)).toEqual(intent);
  expect(intent.status).toBe('want-to-read');
});

test('VN stale recovery reads the winner and a later undo is visible to another client', async () => {
  const fixture = contractFixture('visual-novels', 'stale');
  const loaded = await load(fixture);
  if (!loaded.view.ok) throw new Error('Library did not load');
  const work = loaded.view.data.rows[0]!.work.id;
  const first = mainTrackingApi(fixture.actor, () => fixture.main).media!;
  const second = mainTrackingApi(fixture.actor, () => fixture.main).media!;
  expect(await first.markWork(work, 'completed')).toEqual({ ok: false, failure: 'stale',
    current: { standing: 'started', version: 1 }, submitted: 'completed' });
  expect(await second.workStanding(work)).toMatchObject({ ok: true, data: { standing: 'started', version: 1 } });
  expect(await first.markWork(work, 'completed')).toMatchObject({ ok: true, data: { standing: 'completed', version: 2 } });
  expect(await second.markWork(work, 'not-started')).toMatchObject({ ok: true, data: { standing: 'not-started', version: 3 } });
  expect(await first.workStanding(work)).toMatchObject({ ok: true, data: { standing: 'not-started', version: 3 } });
});

test('empty and unavailable visits remain reachable Library page outcomes', async () => {
  const empty = await load(contractFixture('games', 'empty'));
  expect(empty.overview.ok && empty.overview.data.counts).toEqual({ reading: 0, read: 0, 'want-to-read': 0 });
  const error = await load(contractFixture('games', 'error'));
  expect(error.overview).toEqual({ ok: false, failure: 'unavailable' });
});

test('a Library import waits for the HTTP 202 job rather than reporting completion', async () => {
  const fixture = contractFixture('books', 'pending', 'owner');
  await load(fixture);
  const api = mainImportApi(fixture.actor, () => fixture.main);
  const rows = await api.rows(fixture.importId, -1);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]!.source.creators.length).toBeGreaterThan(0);
  expect(await api.apply(fixture.importId, { context: null, language: 'en' })).toMatchObject({
    pending: true, state: 'pending', completed: 0, total: 1 });
  expect(fixture.calls.find(call => call.method === 'POST' && call.path.endsWith('/apply'))?.responseStatus).toBe(202);
});

test('the Read shelf carries the owner’s private imported review through the production reader', async () => {
  const fixture = contractFixture('books', 'private-review', 'owner');
  const loaded = await load(fixture);
  if (!loaded.view.ok) throw new Error('Library did not load');
  expect(loaded.view.data.rows[0]!.privateReview).toMatchObject({ ok: true, data: {
    work: loaded.view.data.rows[0]!.work.id, text: 'Original author — private imported reading note.', language: 'en',
  } });
  const path = fixture.calls.find(call => call.path.startsWith('/v1/me/import-reviews'))!.path;
  expect(new URL(path, 'https://contract.invalid').searchParams.get('actingSubject')).toBe(fixture.actor);
});

test('game required and bonus routes share the Work seam but keep independent marks', async () => {
  const fixture = contractFixture('games');
  const loaded = await load(fixture);
  if (!loaded.view.ok) throw new Error('Library did not load');
  const composed = loaded.view.data.rows[1]!.work.id;
  const media = mainTrackingApi(fixture.actor, () => fixture.main).media!;
  const routes = await media.routes(composed);
  if (!routes.ok) throw new Error('Routes did not load');
  expect(routes.data.items.map(route => route.required)).toEqual([true, false]);
  const required = routes.data.items[0]!;
  const bonus = routes.data.items[1]!;
  expect(await media.mark(required, { completed: true, position: 'completed' })).toMatchObject({ ok: true });
  expect(await media.progress(bonus)).toMatchObject({ ok: true, data: { completed: false, position: null } });
  expect(await media.mark(required, { completed: false, position: null })).toMatchObject({ ok: true });
});

for (const state of ['export-interrupted', 'export-moved'] as const) {
  test(`the Library export client recovers from ${state} without combining different bases`, async () => {
    const fixture = contractFixture('books', state, 'owner');
    await load(fixture);
    const store = memoryExportStore();
    const input = { api: mainExportApi(fixture.actor, () => fixture.main), store, agent: fixture.actor, onProgress: () => {} };
    await expect(collectExport(input)).rejects.toMatchObject({ failure: state === 'export-moved' ? 'moved' : 'unavailable' });
    expect(await store.progress(fixture.actor)).toMatchObject({ rows: 20, snapshot: 'snapshot-1', cursor: 'cursor-20' });
    if (state === 'export-moved') await store.clear(fixture.actor);
    const complete = await collectExport(input);
    expect(complete.snapshot).toBe(state === 'export-moved' ? 'snapshot-2' : 'snapshot-1');
    expect(await collectedRows(store, fixture.actor, complete)).toHaveLength(43);
    const requests = fixture.calls.filter(call => call.path.startsWith('/v1/me/library-export'));
    const resumed = new URL(requests[2]!.path, 'https://contract.invalid');
    expect(resumed.searchParams.get('cursor')).toBe(state === 'export-moved' ? null : 'cursor-20');
    expect(resumed.searchParams.get('snapshot')).toBe(state === 'export-moved' ? null : 'snapshot-1');
  });
}
