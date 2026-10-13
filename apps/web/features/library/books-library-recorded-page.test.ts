import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/books/collection-tracking-and-progress.json';
import exportRecord from '../../../../tests/qa/fixtures/outcomes/books/library-export.json';
import importRecord from '../../../../tests/qa/fixtures/outcomes/books/library-import.json';
import resumeRecord from '../../../../tests/qa/fixtures/outcomes/books/resume-an-interrupted-export-interrupted-exports.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { ExportError, mainExportApi } from '../library-backup/export-api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { ImportError, mainImportApi } from './import-api.ts';
import { parseLibraryState } from './state.ts';

const collection = collectionRecord as AnswerRecord;
const exported = exportRecord as AnswerRecord;
const imported = importRecord as AnswerRecord;
const resume = resumeRecord as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function client(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
}

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

const ownerLibrary: RecordedSelection[] = [
  { label: 'shelf-directory', state: 'populated' },
  { label: 'library-visibility', state: 'populated' },
  { label: 'global-rating-context', state: 'populated' },
  { label: 'yearly-reading-goal', state: 'populated' },
  { label: 'chapter-reading-stats', state: 'populated' },
  { label: 'followed-authors', state: 'populated' },
  { label: 'currently-reading-preview', state: 'populated' },
  { label: 'book-reading-resume', state: 'populated' },
  { label: 'series-reading-resume', state: 'populated' },
  { label: 'book-card-and-chapter-count', state: 'populated' },
];

test('the library mapping shows the owner’s recorded shelves, status and next chapter', async () => {
  const directory = sample(collection, 'owner', 'shelf-directory');
  const main = client(collection, 'owner', ownerLibrary);
  const loaded = await loadBooksLibrary({ main, anonymous: main, actingSubject: actingSubject(directory.path) },
    { state: parseLibraryState({}), locale: 'en', year: 2026, first: true });
  expect(loaded.overview.ok).toBe(true);
  if (!loaded.overview.ok) return;
  expect(loaded.overview.data.counts).toEqual({ reading: 2, 'want-to-read': 0, read: 0 });
  expect(loaded.overview.data.visibility.ok && loaded.overview.data.visibility.data.visibility).toBe('private');
  expect(loaded.reading.map(row => row.work.title && 'value' in row.work.title ? row.work.title.value : null))
    .toEqual(['Original outcome series', 'Original outcome volume']);
  expect(loaded.reading.map(row => row.status)).toEqual(['reading', 'reading']);
  const volume = loaded.reading[1];
  expect(volume?.progress?.next?.title).toBe('Chapter 1');
  expect(volume?.progress?.left).toEqual({ value: 2, kind: 'exact' });
  expect(loaded.stats.ok && loaded.stats.data.chapters).toBe(1);
  expect(loaded.goal.ok && loaded.goal.data.target).toBeNull();
});

test('a moderator’s export and a visitor’s import stay refused by the production adapters', async () => {
  const exportSample = sample(exported, 'moderator', 'get-library-export-0');
  const exportApi = mainExportApi(actingSubject(exportSample.path), () => client(exported, 'moderator',
    [{ label: exportSample.label, state: 'error' }]));
  await expect(exportApi.page({})).rejects.toEqual(expect.any(ExportError));
  await expect(exportApi.page({})).rejects.toMatchObject({ failure: 'denied' });

  const rows = sample(imported, 'visitor', 'get-library-imports-rows-0');
  const importId = rows.path.split('/')[4];
  const importApi = mainImportApi(actingSubject(rows.path), () => client(imported, 'visitor',
    [{ label: rows.label, state: 'error' }]), async () => {});
  await expect(importApi.rows(importId!, -1)).rejects.toEqual(expect.any(ImportError));
  await expect(importApi.rows(importId!, -1)).rejects.toMatchObject({ failure: 'denied' });
});

test('an export continuation whose basis changed is the production restart refusal', async () => {
  const changed = sample(resume, 'owner', 'get-library-export-6');
  const url = new URL(changed.path, 'https://recorded.invalid');
  const api = mainExportApi(actingSubject(changed.path), () => client(resume, 'owner',
    [{ label: changed.label, state: 'error' }]));
  await expect(api.page({ cursor: url.searchParams.get('cursor')!, snapshot: url.searchParams.get('snapshot')! }))
    .rejects.toMatchObject({ failure: 'moved' });
});
