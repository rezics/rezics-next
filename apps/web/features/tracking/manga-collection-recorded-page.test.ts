import { describe, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/manga/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { loadBooksLibrary } from '../library/books-library-recorded-page.ts';
import { parseLibraryState } from '../library/state.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from '../work-page/books-edition-page.read.ts';
import { readAnimeReaderState } from '../work-page/anime-hub-recorded-page.ts';
import { mangaCollectionSample, mangaCollectionSelections, type MangaLibraryPersona } from './manga-collection-recorded-page.ts';
import { mainMediaApi } from './media-api.ts';
import { progressControl } from './medium-progress.tsx';

const record = answers as AnswerRecord;
const personas = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
seedServedTypes();

function identity(persona: AnswerPersona) {
  const url = new URL(mangaCollectionSample(record, persona, 'work-header-1').path, 'https://recorded.invalid');
  return { work: url.pathname.split('/').at(-1)!, actingSubject: url.searchParams.get('actingSubject') ?? undefined };
}

function replay(persona: MangaLibraryPersona) {
  const transport = recordedFetch(record, persona, mangaCollectionSelections(record, persona), { pathPrefix: BFF_PREFIX, sequence: true });
  return { ...transport, main: browserMainApi('https://recorded.invalid', { fetcher: transport.fetcher }) };
}

describe('Manga collection through the production Library and chapter readers', () => {
  for (const persona of personas) {
    test(`${persona}: owns the recorded shelf, status revision, dates and chapter identities across volumes`, async () => {
      const wire = replay(persona);
      try {
        const { work, actingSubject } = identity(persona);
        expect(actingSubject).toBeDefined();
        const loaded = await loadBooksLibrary({ main: wire.main, anonymous: wire.main, actingSubject: actingSubject! }, {
          state: parseLibraryState({ shelf: 'reading', view: 'grid' }), locale: 'en', year: 2026, first: false,
        });
        expect(loaded.overview.ok).toBe(true);
        expect(loaded.view.ok).toBe(true);
        if (!loaded.overview.ok || !loaded.view.ok) throw new Error('Recorded Library visit failed');
        expect(loaded.overview.data.agent).toBe(actingSubject!);
        const shelf = mangaCollectionSample(record, persona, 'library-9').answer as {
          items: { work: string; status: string; version: number; changedAt: string; card: { title: { value: string } } }[];
          nextCursor: string | null;
        };
        expect(loaded.view.data.rows.map(row => row.work.id)).toEqual(shelf.items.map(item => item.work));
        expect(loaded.view.data.nextCursor).toBe(shelf.nextCursor);
        for (const item of shelf.items) {
          const row = loaded.view.data.rows.find(row => row.work.id === item.work)!;
          expect(row.work.title?.value).toBe(item.card.title.value);
          expect(row.status).toBe(item.status);
          expect(row.version).toBe(item.version);
          expect(Date.parse(row.shelvedAt!)).toBe(Date.parse(item.changedAt));
          expect(loaded.view.data.seed[item.work]?.status).toBe(item.status);
        }
        const media = mainMediaApi(actingSubject!, () => wire.main);
        expect(await progressControl(media, null, work, 'book')).toEqual({ kind: 'chapters' });
        const standing = await media.standing(work);
        expect(standing.ok).toBe(true);
        if (!standing.ok) throw new Error(standing.failure);
        const resume = mangaCollectionSample(record, persona, 'chapter-standing-1').answer as { resolved: string };
        expect(standing.data.last?.occurrence).toBe(resume.resolved);
        expect(standing.data.next).toBeNull();
        const inventory = await media.positions(work);
        expect(inventory.ok).toBe(true);
        if (!inventory.ok) throw new Error(inventory.failure);
        expect(inventory.data.items.map(item => item.label)).toEqual([
          'Volume 1, chapter 1', 'Volume 1, chapter 2', 'Volume 2, chapter 1', 'Volume 2, chapter 2',
        ]);
        const raw = mangaCollectionSample(record, persona, 'chapter-inventory-1').answer as {
          items: { role: string; structure: string; occurrence: string }[]; nextCursor: string | null; complete: boolean;
        };
        expect(inventory.data.items.map(({ structure, occurrence }) => ({ structure, occurrence }))).toEqual(
          raw.items.filter(item => item.role === 'chapter').map(({ structure, occurrence }) => ({ structure, occurrence })));
        expect(new Set(inventory.data.items.map(item => item.structure)).size).toBe(2);
        expect(inventory.data.next).toBe(raw.nextCursor);
        expect(inventory.data.complete).toBe(raw.complete);
        const chapter = inventory.data.items[2]!;
        const selected = await media.progress(chapter);
        expect(selected).toMatchObject({ ok: true, data: { completed: false, version: 2, position: null } });
        const mark = await media.mark(chapter, { completed: true, position: null, expectedVersion: 2 });
        expect(mark).toMatchObject({ ok: true, data: { completed: true, version: 3, position: null } });
        const afterMark = await media.standing(work);
        expect(afterMark).toMatchObject({ ok: true, data: { last: { occurrence: chapter.occurrence, structure: chapter.structure } } });
        const clear = await media.mark(chapter, { completed: false, position: null, expectedVersion: 3 });
        expect(clear).toMatchObject({ ok: true, data: { completed: false, version: 4, position: null } });
        expect(await media.standing(work)).toEqual(standing);
      } finally { wire.dispose(); }
    });

    test(`${persona}: a foreign progress refusal retains the recorded problem and the other reader's answer`, async () => {
      const refusal = mangaCollectionSample(record, persona, 'proof-23');
      const before = mangaCollectionSample(record, persona, 'proof-18');
      const after = mangaCollectionSample(record, persona, 'proof-27');
      expect(after.answer).toEqual(before.answer);
      const actor = new URL(refusal.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
      const parts = new URL(refusal.path, 'https://recorded.invalid').pathname.split('/');
      const transport = recordedFetch(record, persona, [{ label: refusal.label, state: 'error' }], { pathPrefix: BFF_PREFIX });
      try {
        const main = browserMainApi('https://recorded.invalid', { fetcher: transport.fetcher });
        const loaded = await mainMediaApi(actor, () => main).progress({ structure: parts[3]!, occurrence: parts[5]! });
        expect(loaded).toMatchObject({ ok: false, status: refusal.status, problem: refusal.answer });
      } finally { transport.dispose(); }
    });
  }

  test('visitor: public Work identity and native credit; the production frame sends no private reader-state request', async () => {
    const transport = recordedFetch(record, 'visitor', [
      { label: 'work-header-1', state: 'populated' }, { label: 'work-agent-credits-1', state: 'populated' },
    ], { pathPrefix: BFF_PREFIX });
    try {
      const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: transport.fetcher });
      const { work, actingSubject } = identity('visitor');
      expect(actingSubject).toBeUndefined();
      const reads = booksEditionReads({ main });
      expect(await reads.readWorkHeader(work)).toEqual({ ok: true, data: mangaCollectionSample(record, 'visitor', 'work-header-1').answer });
      expect(await reads.readAgentCredits(work)).toEqual({ ok: true, data: mangaCollectionSample(record, 'visitor', 'work-agent-credits-1').answer });
      expect(await readAnimeReaderState(main, undefined, work)).toBeNull();
    } finally { transport.dispose(); }
  });
});
