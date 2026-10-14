import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/recipes/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import { mainLibraryApi } from './api.ts';
import { loadBooksLibrary, readFollowedAuthors, readReadingYear, readYearlyGoal } from './books-library-recorded-page.ts';
import { parseLibraryState } from './state.ts';

const record = collectionRecord as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function client(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
}

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${record.row}/${persona}/${label}`);
  return found;
}

function actingSubject(path: string) {
  const subject = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded path has no actingSubject: ${path}`);
  return subject;
}

function workId(path: string) {
  const id = path.match(/\/(?:works|progress-summaries)\/([0-9a-f-]{36})/u)?.[1];
  if (!id) throw new Error(`Recorded path has no work: ${path}`);
  return `https://rezics.com/id/${id}`;
}

/** The page's reader store always refreshes; the action type leaves that optional for other adapters. */
async function refreshed(store: ReturnType<typeof createReaderStore>, id: string) {
  if (!store.refresh || !store.available) throw new Error('Library reader store cannot refresh');
  await store.refresh(id);
  return store.available();
}

const ownerGoal = sample('owner', 'library-reading-goal');
const owner = actingSubject(ownerGoal.path);
const work = workId(sample('owner', 'progress-summary-empty').path);

test('the library mapping reads the owner’s recorded goal, year, visibility and recipe standing', async () => {
  const goalClient = client('owner', [{ label: 'library-reading-goal', state: 'populated' }]);
  const goal = await readYearlyGoal({ main: goalClient, anonymous: goalClient, actingSubject: owner }, 2026);
  expect(goal).toEqual({ ok: true, data: { year: 2026, target: null, completed: 0, version: 0, changedAt: null } });

  const statsClient = client('owner', [{ label: 'library-reading-stats', state: 'populated' }]);
  const stats = await readReadingYear({ main: statsClient, anonymous: statsClient, actingSubject: owner }, 2026);
  expect(stats.ok && stats.data.year).toBe(2026);
  expect(stats.ok && stats.data.books).toBe(0);
  expect(stats.ok && stats.data.chapters).toBe(0);

  const authorsClient = client('owner', [{ label: 'library-followed-authors-empty', state: 'empty' }]);
  const authors = await readFollowedAuthors({ main: authorsClient, anonymous: authorsClient, actingSubject: owner }, 'en');
  expect(authors.ok && authors.data.items).toEqual([]);

  const visibility = await mainLibraryApi(owner, () => client('owner', [
    { label: 'library-visibility', state: 'populated' }])).readVisibility();
  expect(visibility).toEqual({ ok: true, data: { visibility: 'private', version: 0, changedAt: null } });

  const summary = await mainTrackingApi(owner, () => client('owner', [
    { label: 'progress-summary-empty', state: 'populated' }])).series(work, 'en');
  expect(summary.ok && summary.data).toMatchObject({ resource: work, status: 'not-started', language: 'en',
    counts: { completed: 0, required: 1, completedRequired: 0 } });

  const standing = await mainTrackingApi(owner, () => client('owner', [
    { label: 'progress-empty', state: 'populated' }])).media!.workStanding(work);
  expect(standing).toEqual({ ok: true, data: { standing: 'not-started', version: 0 } });

  const readBack = sample('owner', 'reader-state-reading');
  const store = createReaderStore({ actingSubject: actingSubject(readBack.path), main: () => client('owner', [
    { label: 'reader-state-reading', state: 'populated' }]) });
  expect(await refreshed(store, workId(readBack.path))).toBe(true);
  expect(store.stateOf(workId(readBack.path)).status).toBe('reading');
});

test('the owner’s recipe progress keeps its compare-and-set version, replay and stale refusal', async () => {
  const replay = await mainTrackingApi(owner, () => client('owner', [
    { label: 'progress-empty', state: 'populated' },
    { label: 'progress-replay', state: 'populated' },
  ])).media!.markWork(work, 'started');
  expect(replay).toMatchObject({ ok: true, data: { work, standing: 'started', version: 1, replayed: true } });

  const status = createReaderStore({ actingSubject: owner, main: () => client('owner', [
    { label: 'reader-status-reading', state: 'populated' }]), seed: { [work]: { status: null, version: 0, rating: null } } });
  expect(await status.setStatus(work, 'reading')).toBe(true);
  expect(status.stateOf(work).status).toBe('reading');

  const stale = await mainTrackingApi(owner, () => client('owner', [
    { label: 'progress-empty', state: 'populated' },
    { label: 'progress-stale', state: 'error' },
  ])).media!.markWork(work, 'completed');
  const refused = sample('owner', 'progress-stale');
  expect(stale).toEqual({ ok: false, failure: 'stale', status: refused.status, problem: refused.answer,
    current: { standing: 'not-started', version: 0 }, submitted: 'completed' });
});

test('a visitor and another Person are refused the owner’s private recipe tracking', async () => {
  const visitor = sample('visitor', 'progress-authentication-required');
  const visitorStanding = await mainTrackingApi(actingSubject(visitor.path), () => client('visitor', [
    { label: visitor.label, state: 'error' }])).media!.workStanding(workId(visitor.path));
  expect(visitorStanding).toEqual({ ok: false, failure: 'sign-in', status: visitor.status, problem: visitor.answer });

  for (const persona of ['stranger', 'member', 'moderator', 'operator'] as const) {
    const denied = sample(persona, 'peer-progress-summary-denied');
    const summary = await mainTrackingApi(actingSubject(denied.path), () => client(persona, [
      { label: denied.label, state: 'error' }])).series(workId(denied.path));
    expect(summary).toEqual({ ok: false, failure: 'sign-in' });

    const state = sample(persona, 'peer-reader-state-denied');
    const store = createReaderStore({ actingSubject: actingSubject(state.path), main: () => client(persona, [
      { label: state.label, state: 'error' }]) });
    expect(await refreshed(store, workId(state.path))).toBe(false);
  }

  const ownerPeer = sample('owner', 'peer-reader-state-denied');
  const ownerStore = createReaderStore({ actingSubject: actingSubject(ownerPeer.path), main: () => client('owner', [
    { label: ownerPeer.label, state: 'error' }]) });
  expect(await refreshed(ownerStore, workId(ownerPeer.path))).toBe(false);
});

test('the library page cannot show the recorded shelves: its directory query is not in the record', async () => {
  const directory = sample('owner', 'shelves');
  const subject = actingSubject(directory.path);
  expect(new URL(directory.path, 'https://recorded.invalid').searchParams.has('limit')).toBe(false);
  const replay = recordedFetch(record, 'owner', [{ label: directory.label, state: 'populated' }], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const asked = `/v1/me/shelves?actingSubject=${encodeURIComponent(subject)}&limit=20`;
  await expect(replay.fetcher(new Request(`https://recorded.invalid${BFF_PREFIX}${asked}`))).rejects.toThrow(
    `Unmatched recorded request (${record.row}/owner): ${JSON.stringify({ method: 'GET', path: `${BFF_PREFIX}${asked}`, body: '<absent>' })}`);

  const main = client('owner', [
    { label: 'library-visibility', state: 'populated' },
    { label: 'library-rating-contexts', state: 'empty' },
    { label: 'library-reading-goal', state: 'populated' },
    { label: 'library-reading-stats', state: 'populated' },
    { label: 'library-followed-authors-empty', state: 'empty' },
  ]);
  const loaded = await loadBooksLibrary({ main, anonymous: main, actingSubject: subject },
    { state: parseLibraryState({}), locale: 'en', year: 2026, first: true });
  expect(loaded.overview).toEqual({ ok: false, failure: 'unavailable' });
  expect(loaded.goal.ok && loaded.goal.data.target).toBeNull();
  expect(loaded.authors?.ok && loaded.authors.data.items).toEqual([]);
});
