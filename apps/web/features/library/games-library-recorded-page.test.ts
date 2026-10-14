import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/games/collection-tracking-and-progress.json';
import deviceRecord from '../../../../tests/qa/fixtures/outcomes/games/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { WorkStanding } from '../tracking/media-api.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { parseLibraryState } from './state.ts';

const collection = collectionRecord as AnswerRecord;
const devices = deviceRecord as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${record.row}/${persona}/${label}`);
  return found;
}

function actingSubject(path: string) {
  const subject = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded path has no actingSubject: ${path}`);
  return subject;
}

function media(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[], subject: string) {
  const progress = mainTrackingApi(subject, () => client(record, persona, selections)).media;
  if (!progress) throw new Error('Tracking adapter has no media progress');
  return progress;
}

function client(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[], asked: string[] = []) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    asked.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
    return replay.fetcher(input, init);
  }) as typeof fetch;
  return browserMainApi('https://recorded.invalid', { fetcher });
}

const memberLibrary: RecordedSelection[] = [
  { label: 'library-overview', state: 'populated' },
  { label: 'library-visibility', state: 'populated' },
  { label: 'library-rating-context', state: 'populated' },
  { label: 'reading-goal', state: 'populated' },
  { label: 'reading-year', state: 'populated' },
  { label: 'followed-authors', state: 'empty' },
];

test('the library mapping shows the member’s recorded shelves, private library and chapter year', async () => {
  const directory = sample(collection, 'member', 'library-overview');
  const main = client(collection, 'member', memberLibrary);
  const loaded = await loadBooksLibrary({ main, anonymous: main, actingSubject: actingSubject(directory.path) },
    { state: parseLibraryState({}), locale: 'en', year: 2026, first: true });
  expect(loaded.overview.ok).toBe(true);
  if (!loaded.overview.ok) return;
  expect(loaded.overview.data.counts).toEqual({ reading: 2, 'want-to-read': 1, read: 0 });
  expect(loaded.overview.data.visibility.ok && loaded.overview.data.visibility.data.visibility).toBe('private');
  expect(loaded.overview.data.customShelves).toEqual([]);
  expect(loaded.goal.ok && loaded.goal.data).toMatchObject({ year: 2026, target: null, completed: 0, version: 0 });
  expect(loaded.stats.ok && loaded.stats.data.year).toBe(2026);
  expect(loaded.stats.ok && loaded.stats.data.chapters).toBe(2);
  expect(loaded.stats.ok && loaded.stats.data.books).toBe(0);
  expect(loaded.authors?.ok && loaded.authors.data.items).toEqual([]);
  expect(loaded.view.ok && loaded.view.data.total).toBe(3);
});

test('the currently-reading page the library reader requests is not the recorded one', async () => {
  const preview = sample(collection, 'member', 'currently-reading');
  const recordedLimit = new URL(preview.path, 'https://recorded.invalid').searchParams.get('limit');
  const titles = (preview.answer as { items: { card: { title: { value: string } } }[] }).items
    .map(item => item.card.title.value);
  expect(recordedLimit).toBe('6');
  expect(titles).toEqual([
    'Original garden with main and bonus routes',
    'Original neighbouring garden game',
  ]);
  const asked: string[] = [];
  const directory = sample(collection, 'member', 'library-overview');
  const main = client(collection, 'member', [...memberLibrary, { label: preview.label, state: 'populated' }], asked);
  const loaded = await loadBooksLibrary({ main, anonymous: main, actingSubject: actingSubject(directory.path) },
    { state: parseLibraryState({}), locale: 'en', year: 2026, first: true });
  const reading = asked.find(line => line.includes('/v1/me/shelves/status/reading/works'));
  expect(reading).toBe(
    `GET /api/main/v1/me/shelves/status/reading/works?actingSubject=${encodeURIComponent(actingSubject(directory.path))}&sort=last-read&order=desc&limit=3`);
  expect(loaded.reading).toEqual([]);
});

test('a visitor cannot read game progress, and a foreign library read stays refused', async () => {
  const progress = sample(collection, 'visitor', 'sign-in-/v1/works/01a13624-9ebd-74c9-a463-c8e102e57230/progress');
  expect(progress.status).toBe(401);
  expect(progress.answer).toMatchObject({ status: 401, code: 'account_assertion_denied' });
  const work = progress.path.split('?')[0]!.split('/').at(-2);
  expect(await media(collection, 'visitor', [{ label: progress.label, state: 'error' }], actingSubject(progress.path))
    .workStanding(`https://rezics.com/id/${work}`)).toEqual({ ok: false, failure: 'sign-in' });

  const foreign = sample(collection, 'member', 'private-reader-state');
  expect(foreign.status).toBe(403);
  expect(foreign.answer).toMatchObject({ status: 403, code: 'reader_library_denied' });
  const store = createReaderStore({
    actingSubject: actingSubject(foreign.path),
    main: () => client(collection, 'member', [{ label: foreign.label, state: 'error' }]),
  });
  if (!store.refresh || !store.available) throw new Error('Library reader store cannot refresh');
  await store.refresh(`https://rezics.com/id/${foreign.path.split('/')[3]}`);
  expect(store.available()).toBe(false);
});

test('the other device’s completed mark is the progress the tracking adapter reads', async () => {
  const won = sample(devices, 'member', 'whole-device-a-completed');
  const answer = won.answer as { work: string; standing: WorkStanding; version: number; parts: boolean };
  expect(answer).toEqual({
    work: 'https://rezics.com/id/01a135ed-01ae-7680-89b5-eff9cb5600c7',
    standing: 'completed', version: 3, parts: false,
  });
  expect(await media(devices, 'member', [{ label: won.label, state: 'populated' }], actingSubject(won.path))
    .workStanding(answer.work)).toEqual({
    ok: true, data: { standing: answer.standing, version: answer.version },
  });
});

test('a stale whole-game save keeps the other device’s recorded mark', async () => {
  const current = sample(devices, 'member', 'whole-device-b-initial');
  const stale = sample(devices, 'member', 'whole-stale-write');
  expect(stale.status).toBe(409);
  expect(stale.answer).toMatchObject({ status: 409, code: 'stale_progress' });
  const held = current.answer as { work: string; standing: WorkStanding; version: number };
  expect(await media(devices, 'member', [
    { label: current.label, state: 'populated' },
    { label: stale.label, state: 'error' },
  ], actingSubject(current.path)).markWork(held.work, 'completed')).toEqual({
    ok: false, failure: 'stale', current: { standing: held.standing, version: held.version }, submitted: 'completed',
  });
});

test('a game whose progress is kept on its parts is not a whole-game mark', async () => {
  const parts = sample(collection, 'member', 'composed-progress');
  const answer = parts.answer as { work: string; parts: boolean };
  expect(answer.parts).toBe(true);
  expect(await media(collection, 'member', [{ label: parts.label, state: 'populated' }], actingSubject(parts.path))
    .workStanding(answer.work)).toEqual({ ok: false, failure: 'has-parts' });
});
