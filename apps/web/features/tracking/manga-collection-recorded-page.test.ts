import { localizedPath } from '../../i18n/locale.ts';
import { workHref } from '../work-page/route.ts';
import { describe, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/manga/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { loadBooksLibrary } from '../library/books-library-recorded-page.ts';
import { parseLibraryState } from '../library/state.ts';
import type { ShelfStatus } from '../library/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from '../work-page/books-edition-page.read.ts';
import type { AgentCreditPage, WorkHeader } from '../work-page/types.ts';
import { readAnimeReaderState } from '../work-page/anime-hub-recorded-page.ts';
import { mangaCollectionSample, mangaCollectionSelections, mangaWorkSelections, type MangaLibraryPersona } from './manga-collection-recorded-page.ts';
import { mangaWorkVisit } from './manga-collection-recorded-page.work.tsx';
import { finishMangaSlots } from './manga-collection-recorded-page.test-support.ts';
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
  const commands: { path: string; body: unknown }[] = [];
  const fetcher = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'PUT') commands.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
    return transport.fetcher(input, init);
  }) as typeof fetch;
  return { ...transport, commands, main: browserMainApi('https://recorded.invalid', { fetcher }) };
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
          items: { work: string; status: ShelfStatus | null; version: number; changedAt: string; card: { title: { value: string } } }[];
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
        const actions = createReaderStore({ main: () => wire.main, actingSubject: actingSubject!, seed: loaded.view.data.seed });
        const workIri = `https://rezics.com/id/${work}`;
        expect(await actions.setStatus(workIri, 'read')).toBe(true);
        expect(actions.stateOf(workIri).status).toBe('read');
        const changed = mangaCollectionSample(record, persona, 'status-change-1').answer as {
          version: number;
        };
        expect(await actions.setStatus(workIri, 'reading')).toBe(true);
        expect(actions.stateOf(workIri).status).toBe('reading');
        expect(wire.commands.at(-1)).toEqual({ path: `${BFF_PREFIX}/v1/works/${work}/reader-status`,
          body: { actingSubject, status: 'reading', expectedVersion: changed.version } });
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
      expect(await reads.readWorkHeader(work)).toEqual({ ok: true, data: mangaCollectionSample(record, 'visitor', 'work-header-1').answer as WorkHeader });
      expect(await reads.readAgentCredits(work)).toEqual({ ok: true, data: mangaCollectionSample(record, 'visitor', 'work-agent-credits-1').answer as AgentCreditPage });
      expect(await readAnimeReaderState(main, undefined, work)).toBeNull();
    } finally { transport.dispose(); }
  });
});


describe('Manga Work frame and public inventory through the production composition', () => {
  for (const persona of ['visitor', ...personas] as const) {
    test(`${persona}: reads the actual overview and frame without a replay miss`, async () => {
      const transport = recordedFetch(record, persona, mangaWorkSelections(record, persona, 'work-overview'), {
        pathPrefix: BFF_PREFIX, sequence: true,
      });
      const misses: string[] = [];
      const requests: { method: string; path: string; body: unknown }[] = [];
      const fetcher = (async (input, init) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, path: new URL(request.url).pathname,
          body: request.method === 'GET' ? undefined : await request.clone().json() });
        try { return await transport.fetcher(input, init); }
        catch (error) { misses.push(String(error)); throw error; }
      }) as typeof fetch;
      const main = browserMainApi('https://recorded.invalid', { fetcher });
      const { work, actingSubject } = identity(persona);
      try {
        const visit = await mangaWorkVisit({ main, anonymous: browserMainApi('https://recorded.invalid', { fetcher, anonymous: true }),
          actingSubject, signedIn: persona !== 'visitor',
          avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '',
          pageUrl: new URL(localizedPath(workHref(work), 'en'), 'https://rezics.com').href }, work, 'overview');
        expect(visit.ok).toBe(true);
        if (!visit.ok) throw new Error(visit.failure);
        await finishMangaSlots(visit.page);
        expect(requests).toContainEqual({ method: 'POST', path: `${BFF_PREFIX}/v1/resources/showcase`,
          body: { profile: 'work-showcase-batch-v1', targets: [visit.work.id] } });
        expect(visit.work).toEqual(mangaCollectionSample(record, persona, 'work-header-1').answer as WorkHeader);
        const credits = await visit.page.props.credits.props.children;
        expect(credits.props.agentCredits).toEqual({ ok: true,
          data: mangaCollectionSample(record, persona, 'work-agent-credits-1').answer });
        expect(visit.page.props.signedIn).toBe(persona !== 'visitor');
        expect(visit.page.props.actingSubject).toBe(actingSubject ?? null);
        expect(misses).toEqual([]);
      } finally { transport.dispose(); }
    });
  }
  for (const surface of ['inventory-series', 'inventory-volume1', 'inventory-volume2'] as const) {
    test(`visitor: actual public ${surface} keeps its recorded identity and chapter inventory`, async () => {
      const transport = recordedFetch(record, 'visitor', mangaWorkSelections(record, 'visitor', surface), {
        pathPrefix: BFF_PREFIX, sequence: true,
      });
      const misses: string[] = [];
      const requests: { method: string; path: string; body: unknown }[] = [];
      const fetcher = (async (input, init) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, path: new URL(request.url).pathname,
          body: request.method === 'GET' ? undefined : await request.clone().json() });
        try { return await transport.fetcher(input, init); }
        catch (error) { misses.push(String(error)); throw error; }
      }) as typeof fetch;
      const main = browserMainApi('https://recorded.invalid', { fetcher, anonymous: true });
      const sample = mangaCollectionSample(record, 'visitor', `${surface}-1`);
      const id = new URL(sample.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
      try {
        const visit = await mangaWorkVisit({ main, anonymous: main, signedIn: false,
          pageUrl: new URL(localizedPath(workHref(id, 'contents'), 'en'), 'https://rezics.com').href }, id, 'contents');
        expect(visit.ok).toBe(true);
        if (!visit.ok) throw new Error(visit.failure);
        await finishMangaSlots(visit.page);
        expect(requests).toContainEqual({ method: 'POST', path: `${BFF_PREFIX}/v1/resources/showcase`,
          body: { profile: 'work-showcase-batch-v1', targets: [visit.work.id] } });
        expect(visit.work).toEqual(sample.answer as WorkHeader);
        expect(visit.page.props.signedIn).toBe(false);
        expect(visit.page.props.actingSubject).toBeNull();
        const contents = visit.page.props.children;
        expect(contents.props.contents.ok).toBe(true);
        expect(contents.props.contents.data.items).toHaveLength(2);
        expect(misses).toEqual([]);
      } finally { transport.dispose(); }
    });
  }
});
