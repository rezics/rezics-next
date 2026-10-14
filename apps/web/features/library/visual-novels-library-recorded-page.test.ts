import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/visual-novels/collection-tracking-and-progress.json';
import deviceRecord from '../../../../tests/qa/fixtures/outcomes/visual-novels/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readingStatuses, type ReadingStatus } from '../catalogue/reader-actions.tsx';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { WorkMark, WorkStanding } from '../tracking/media-api.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { parseLibraryState } from './state.ts';
import type { ShelfStatus } from './types.ts';

const collection = collectionRecord as AnswerRecord;
const devices = deviceRecord as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${record.row}/${persona}/${label}`);
  return found;
}

function actingSubject(path: string) {
  const subject = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded path has no actingSubject: ${path}`);
  return subject;
}

function workIri(path: string) {
  const id = new URL(path, 'https://recorded.invalid').pathname.split('/')[3];
  if (!id) throw new Error(`Recorded path has no work: ${path}`);
  return `https://rezics.com/id/${id}`;
}

function client(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[], missed: string[] = []) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await replay.fetcher(input, init); }
    catch (error) { missed.push(error instanceof Error ? error.message : String(error)); throw error; }
  }) as typeof fetch;
  return browserMainApi('https://recorded.invalid', { fetcher });
}

type ShelfDirectory = { statusShelves: { status: string; count: number }[] };

function recordedCount(directory: ShelfDirectory, status: ShelfStatus): number {
  const count = directory.statusShelves.find(item => item.status === status)?.count;
  if (count === undefined) throw new Error(`Recorded shelves have no ${status} count`);
  return count;
}

function recordedShelfStatus(value: string): ReadingStatus {
  const status = readingStatuses.find(item => item === value);
  if (!status) throw new Error(`Recorded shelf status is not a library status: ${value}`);
  return status;
}

const workStandings = ['not-started', 'started', 'completed', 'dropped'] as const satisfies readonly WorkStanding[];

/** The adapter returns the recorded document. Extra fields stay in the comparison. */
function recordedWorkMark(value: unknown): WorkMark {
  if (!value || typeof value !== 'object') throw new Error('Recorded progress answer is not an object');
  const standing = workStandings.find(item => item === (value as { standing?: unknown }).standing);
  if (!standing || typeof (value as { version?: unknown }).version !== 'number') {
    throw new Error('Recorded progress answer has no standing and version');
  }
  return value as WorkMark;
}
type ShelfPreview = { items: { work: string; status: string; version: number; card: { title: { value: string }; types: string[] } }[] };
type ProgressMark = { work: string; standing: WorkStanding; version: number; parts?: boolean; replayed?: boolean };
type StatusWrite = { actingSubject: string; expectedVersion: number; status: ReadingStatus | null };

const populated = (labels: readonly string[]): RecordedSelection[] =>
  labels.map(label => ({ label, state: 'populated' as const }));

/** What `/library` reads on All before any visual novel is shelved. */
const emptyLibrary = populated([
  'library-empty-overview', 'library-visibility', 'library-empty-rating-context', 'library-empty-reading-goal',
  'library-empty-reading-stats', 'library-empty-followed-authors',
]);

/** The recorded All visit while the visual novel is on Currently reading, including its one-work reader state. */
const readingLibrary = populated([
  'visit-library-reading-all-overview', 'visit-library-reading-all-visibility', 'visit-library-reading-all-rating-context',
  'visit-library-reading-all-reading-goal', 'visit-library-reading-all-reading-stats', 'visit-library-reading-all-followed-authors',
  'visit-library-reading-all-shelf-reading', 'visit-library-reading-all-work-states', 'visit-library-reading-all-resume-work',
]);

/** The recorded All visit after the visual novel is marked read. Nothing is left on Currently reading. */
const readAllLibrary = populated([
  'visit-library-read-all-overview', 'visit-library-read-all-visibility', 'visit-library-read-all-rating-context',
  'visit-library-read-all-reading-goal', 'visit-library-read-all-reading-stats', 'visit-library-read-all-followed-authors',
]);

/** The recorded Read shelf visit: the shelf page, that work's reader state, and its import review. */
const readShelfLibrary = populated([
  'visit-library-read-read-overview', 'visit-library-read-read-visibility', 'visit-library-read-read-rating-context',
  'visit-library-read-read-reading-goal', 'visit-library-read-read-reading-stats', 'visit-library-read-read-shelf-read',
  'visit-library-read-read-work-states', 'visit-library-read-read-import-reviews',
]);

function recordedYear(record: AnswerRecord, persona: AnswerPersona, label: string) {
  return Number(new URL(sample(record, persona, label).path, 'https://recorded.invalid').searchParams.get('year'));
}

function titleOf(row: { work: { title: { value: string } | null } }) {
  return row.work.title && 'value' in row.work.title ? row.work.title.value : null;
}

async function loadVisit(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[],
  overviewLabel: string, goalLabel: string, shelf: Record<string, string>, missed: string[]) {
  const overview = sample(record, persona, overviewLabel);
  const main = client(record, persona, selections, missed);
  const state = parseLibraryState(shelf);
  return loadBooksLibrary({ main, anonymous: main, actingSubject: actingSubject(overview.path) },
    { state, locale: 'en', year: recordedYear(record, persona, goalLabel), first: state.shelf.kind === 'all' && state.cursor === null });
}

test('the member’s empty visual-novel library is the recorded zero shelves', async () => {
  const overview = sample(collection, 'member', 'library-empty-overview').answer as ShelfDirectory;
  const missed: string[] = [];
  const loaded = await loadVisit(collection, 'member', emptyLibrary, 'library-empty-overview', 'library-empty-reading-goal',
    {}, missed);
  expect(missed).toEqual([]);
  expect(loaded.overview.ok).toBe(true);
  if (!loaded.overview.ok) return;
  expect(loaded.overview.data.counts).toEqual({
    reading: recordedCount(overview, 'reading'),
    'want-to-read': recordedCount(overview, 'want-to-read'),
    read: recordedCount(overview, 'read'),
  });
  expect(loaded.overview.data.visibility.ok && loaded.overview.data.visibility.data.visibility).toBe('private');
  expect(loaded.reading).toEqual([]);
  expect(loaded.goal.ok && loaded.goal.data.target).toBeNull();
  expect(loaded.stats.ok && loaded.stats.data.chapters).toBe(0);
  expect(loaded.authors?.ok && loaded.authors.data.items).toEqual([]);
});

test('the member’s reading shelf shows the recorded visual novel and no next chapter', async () => {
  const preview = sample(collection, 'member', 'visit-library-reading-all-shelf-reading');
  const item = (preview.answer as ShelfPreview).items[0]!;
  const states = sample(collection, 'member', 'visit-library-reading-all-work-states');
  const resume = sample(collection, 'member', 'visit-library-reading-all-resume-work').answer as {
    nextUnread: unknown; unreadCount: unknown };
  const missed: string[] = [];
  const loaded = await loadVisit(collection, 'member', readingLibrary, 'visit-library-reading-all-overview',
    'visit-library-reading-all-reading-goal', {}, missed);
  expect(missed).toEqual([]);
  expect(loaded.overview.ok).toBe(true);
  if (!loaded.overview.ok) return;
  expect(loaded.overview.data.counts.reading).toBe(1);
  expect(new URL(states.path, 'https://recorded.invalid').searchParams.get('works')).toBe(item.work);
  expect(loaded.reading.map(titleOf)).toEqual([item.card.title.value]);
  expect(loaded.reading.map(row => row.status)).toEqual([recordedShelfStatus(item.status)]);
  expect(loaded.reading.map(row => row.version)).toEqual([item.version]);
  expect(loaded.reading.map(row => row.types)).toEqual([item.card.types]);
  expect(loaded.reading.map(row => row.stateRead)).toEqual([true]);
  expect(resume.nextUnread).toBeNull();
  expect(resume.unreadCount).toBeNull();
  expect(loaded.reading[0]?.progress).toEqual({ next: null, left: null, chapters: null });
});

test('the member’s All page after the visual novel is read keeps the recorded counts and no current title', async () => {
  const overview = sample(collection, 'member', 'visit-library-read-all-overview').answer as ShelfDirectory;
  const missed: string[] = [];
  const loaded = await loadVisit(collection, 'member', readAllLibrary, 'visit-library-read-all-overview',
    'visit-library-read-all-reading-goal', {}, missed);
  expect(missed).toEqual([]);
  expect(loaded.overview.ok && loaded.overview.data.counts).toEqual({
    reading: recordedCount(overview, 'reading'),
    'want-to-read': recordedCount(overview, 'want-to-read'),
    read: recordedCount(overview, 'read'),
  });
  expect(loaded.reading).toEqual([]);
  expect(loaded.view.ok && loaded.view.data.rows).toEqual([]);
});

test('the member’s Read shelf lists the recorded visual novel', async () => {
  const shelf = sample(collection, 'member', 'visit-library-read-read-shelf-read');
  const item = (shelf.answer as ShelfPreview).items[0]!;
  const states = sample(collection, 'member', 'visit-library-read-read-work-states');
  const missed: string[] = [];
  const loaded = await loadVisit(collection, 'member', readShelfLibrary, 'visit-library-read-read-overview',
    'visit-library-read-read-reading-goal', { shelf: 'read' }, missed);
  expect(missed).toEqual([]);
  expect(loaded.reading).toEqual([]);
  expect(loaded.authors).toBeNull();
  expect(loaded.view.ok).toBe(true);
  if (!loaded.view.ok) return;
  expect(new URL(states.path, 'https://recorded.invalid').searchParams.get('works')).toBe(item.work);
  expect(loaded.view.data.rows.map(titleOf)).toEqual([item.card.title.value]);
  expect(loaded.view.data.rows.map(row => row.status)).toEqual([recordedShelfStatus(item.status)]);
  expect(loaded.view.data.rows.map(row => row.version)).toEqual([item.version]);
  expect(loaded.view.data.rows.map(row => row.stateRead)).toEqual([true]);
  expect(loaded.view.data.rows[0]?.privateReview).toEqual({ ok: true, data: null });
  expect(item.status).toBe('read');
});

// `/library` does not read work progress. These are the shelves the page reached after the winning mark.
const deviceAll = (persona: 'member' | 'owner') => populated([
  'visit-library-final-all-overview', 'visit-library-final-all-visibility', 'visit-library-final-all-rating-context',
  'visit-library-final-all-reading-goal', 'visit-library-final-all-reading-stats', 'visit-library-final-all-followed-authors',
  ...(persona === 'owner' ? [
    'visit-library-final-all-shelf-reading', 'visit-library-final-all-work-states',
    'visit-library-final-all-resume-visitor-work', 'visit-library-final-all-resume-visitor-other-work',
  ] : []),
]);

for (const persona of ['member', 'owner'] as const) {
  test(`${persona}: the recorded library after the winning mark does not list that visual novel`, async () => {
    const overview = sample(devices, persona, 'visit-library-final-all-overview').answer as ShelfDirectory;
    const mark = sample(devices, persona, 'primary-get-works-progress-0').answer as ProgressMark;
    const missed: string[] = [];
    const loaded = await loadVisit(devices, persona, deviceAll(persona), 'visit-library-final-all-overview',
      'visit-library-final-all-reading-goal', {}, missed);
    expect(missed).toEqual([]);
    expect(loaded.overview.ok && loaded.overview.data.counts).toEqual({
      reading: recordedCount(overview, 'reading'),
      'want-to-read': recordedCount(overview, 'want-to-read'),
      read: recordedCount(overview, 'read'),
    });
    const shown = [
      ...loaded.reading.map(row => row.work.id),
      ...loaded.view.ok ? loaded.view.data.rows.map(row => row.work.id) : [],
    ];
    expect(shown).not.toContain(mark.work);
    expect(mark).toMatchObject({ standing: 'completed', version: 2 });
    if (persona === 'owner') {
      const preview = sample(devices, persona, 'visit-library-final-all-shelf-reading').answer as ShelfPreview;
      expect(loaded.reading.map(titleOf)).toEqual(preview.items.map(item => item.card.title.value));
      expect(loaded.reading.map(row => row.status)).toEqual(preview.items.map(item => recordedShelfStatus(item.status)));
      expect(loaded.reading.every(row => row.progress?.next === null)).toBe(true);
    } else {
      expect(loaded.reading).toEqual([]);
    }
  });
}

for (const persona of ['member', 'owner'] as const) {
  test(`${persona}: the other device’s winning visual-novel progress is the recorded completed mark`, async () => {
    const saved = sample(devices, persona, 'primary-get-works-progress-0');
    const mark = saved.answer as ProgressMark;
    const missed: string[] = [];
    const main = client(devices, persona, [{ label: saved.label, state: 'populated' }], missed);
    const media = mainTrackingApi(actingSubject(saved.path), () => main).media;
    if (!media) throw new Error('tracking api has no work progress');
    expect(await media.workStanding(mark.work)).toEqual({ ok: true, data: { standing: mark.standing, version: mark.version } });
    expect(mark).toMatchObject({ standing: 'completed', version: 2, parts: false });
    expect(missed).toEqual([]);
  });

  test(`${persona}: a stale visual-novel progress write keeps the recorded version`, async () => {
    const current = sample(devices, persona, 'second-device-get-works-progress-0');
    const refused = sample(devices, persona, 'second-device-put-works-progress-0');
    const mark = current.answer as ProgressMark;
    const body = refused.body as { standing: WorkStanding; expectedVersion: number };
    const missed: string[] = [];
    const main = client(devices, persona, [
      { label: current.label, state: 'populated' },
      { label: refused.label, state: 'error' },
    ], missed);
    const media = mainTrackingApi(actingSubject(current.path), () => main).media;
    if (!media) throw new Error('tracking api has no work progress');
    expect(await media.markWork(mark.work, body.standing)).toEqual({
      ok: false, failure: 'stale', status: refused.status, problem: refused.answer, current: { standing: mark.standing, version: mark.version }, submitted: body.standing });
    expect(body.expectedVersion).toBe(mark.version);
    expect(refused.status).toBe(409);
    expect(missed).toEqual([]);
  });

  test(`${persona}: replaying the winning visual-novel progress returns the recorded replay`, async () => {
    const current = sample(devices, persona, 'second-device-get-works-progress-1');
    const replayed = sample(devices, persona, 'second-device-put-works-progress-2');
    const mark = current.answer as ProgressMark;
    const body = replayed.body as { standing: WorkStanding; expectedVersion: number };
    const missed: string[] = [];
    const main = client(devices, persona, [
      { label: current.label, state: 'populated' },
      { label: replayed.label, state: 'populated' },
    ], missed);
    const media = mainTrackingApi(actingSubject(current.path), () => main).media;
    if (!media) throw new Error('tracking api has no work progress');
    expect(await media.markWork(mark.work, body.standing)).toEqual({ ok: true, data: recordedWorkMark(replayed.answer) });
    expect(body.expectedVersion).toBe(mark.version);
    expect(replayed.answer).toMatchObject({ standing: 'completed', version: 2, replayed: true });
    expect(missed).toEqual([]);
  });
}

for (const persona of ['visitor', 'stranger', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: another person’s visual-novel progress stays the recorded refusal`, async () => {
    const refused = devices.personas[persona].find(item => item.method === 'GET' && item.status >= 400
      && item.path.includes('/progress'));
    if (!refused) throw new Error(`Missing recorded progress refusal for ${persona}`);
    const missed: string[] = [];
    const main = client(devices, persona, [{ label: refused.label, state: 'error' }], missed);
    const media = mainTrackingApi(actingSubject(refused.path), () => main).media;
    if (!media) throw new Error('tracking api has no work progress');
    expect(await media.workStanding(workIri(refused.path))).toEqual({ ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer });
    expect(missed).toEqual([]);
  });

  test(`${persona}: saving another person’s visual-novel shelf status stays the recorded refusal`, async () => {
    const refused = collection.personas[persona].find(item => item.method === 'PUT' && item.status >= 400
      && item.path.endsWith('/reader-status'));
    if (!refused?.body) throw new Error(`Missing recorded status refusal for ${persona}`);
    const body = refused.body as StatusWrite;
    const missed: string[] = [];
    const main = client(collection, persona, [{ label: refused.label, state: 'error' }], missed);
    const store = createReaderStore({ actingSubject: body.actingSubject, main: () => main,
      seed: { [workIri(refused.path)]: { status: null, version: body.expectedVersion, rating: null } } });
    expect(await store.setStatus(workIri(refused.path), body.status)).toBe(false);
    expect(missed).toEqual([]);
  });
}
