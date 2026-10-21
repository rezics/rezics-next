import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { messages } from './messages.ts';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import inventoryRecord from '../../../../tests/qa/fixtures/outcomes/books/navigate-a-thousand-chapter-inventory-thousand-chapters.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import {
  BooksContentsRecordedPage, booksContentsInventoryLimit, booksContentsInventoryQuery, booksContentsInventoryQueryFromPath,
  contentsReadsInventory, mapBooksContentsRecordedPage, type BooksContentsRecordedView,
} from './books-contents-recorded-page.tsx';
import { iriOf } from './route.ts';

const record = inventoryRecord as unknown as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

type PageAnswer = {
  work: string;
  items: { occurrence: string; labels?: { value: string; language: string }[]; ordinal?: number }[];
  complete: boolean;
  nextCursor: string | null;
  count: { value: number; kind: string; total: null };
};

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

function chapterLabel(item: PageAnswer['items'][number] | undefined): string {
  const value = item?.labels?.[0]?.value;
  if (!value) throw new Error('recorded chapter has no label');
  return value;
}

function continuation(answer: PageAnswer): string {
  if (!answer.nextCursor) throw new Error('recorded page has no continuation');
  return answer.nextCursor;
}

function watchedFetch(replay: ReturnType<typeof recordedFetch>, seen: string[]): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(input instanceof Request ? input.url : String(input));
    return replay.fetcher(input, init);
  }, { preconnect: fetch.preconnect });
}

async function readRecorded(persona: AnswerPersona, label: string, state: RecordedState) {
  const chosen = sample(persona, label);
  const replay = recordedFetch(record, persona, [{ label, state }], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const seen: string[] = [];
  const fetcher = watchedFetch(replay, seen);
  const { work, query } = booksContentsInventoryQueryFromPath(chosen.path);
  const answer = await browserMainApi('https://recorded.invalid', { anonymous: true, fetcher })
    .v1['reading-positions']({ work }).get({ query });
  const requested = seen.map(url => {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/api\/main/, '') + parsed.search;
  });
  return { chosen, answer, requested, work, query };
}

function mapRecorded(read: Awaited<ReturnType<typeof readRecorded>>): BooksContentsRecordedView {
  return mapBooksContentsRecordedPage(read.answer, {
    workRef: read.work,
    workIri: iriOf(read.work),
    locale: 'en',
    language: typeof read.query.language === 'string' ? read.query.language : undefined,
    cursor: typeof read.query.cursor === 'string' ? read.query.cursor : undefined,
    title: null,
  });
}

test('the inventory query is one hundred chapters in recorded parameter order', () => {
  expect(booksContentsInventoryLimit).toBe(100);
  expect(booksContentsInventoryQuery({
    language: 'en', cursor: 'opaque', actingSubject: 'https://rezics.com/id/person', limit: booksContentsInventoryLimit,
  })).toEqual({
    position: 'start', language: 'en', limit: 100, cursor: 'opaque',
    actingSubject: 'https://rezics.com/id/person',
  });
  expect(Object.keys(booksContentsInventoryQuery({
    language: 'en', q: '重逢', limit: 1, cursor: 'opaque', actingSubject: 'https://rezics.com/id/person',
  }))).toEqual(['position', 'language', 'q', 'limit', 'cursor', 'actingSubject']);
  expect(contentsReadsInventory({ ok: true, data: {} }, {})).toBe(false);
  expect(contentsReadsInventory({ ok: false, failure: 'missing' }, {})).toBe(false);
  expect(contentsReadsInventory({ ok: false, failure: 'invalid' }, {})).toBe(false);
  expect(contentsReadsInventory({ ok: false, failure: 'unavailable' }, { parent: '11111111-1111-4111-8111-111111111111' }))
    .toBe(false);
  expect(contentsReadsInventory({ ok: false, failure: 'unavailable' }, {})).toBe(true);
  expect(contentsReadsInventory({ ok: false, failure: 'invalid' }, { cursor: 'opaque' })).toBe(true);
  expect(contentsReadsInventory({ ok: false, failure: 'moved' }, { cursor: 'opaque' })).toBe(true);
});

test('visitor inventory page keeps the recorded chapters, count and opaque continuation', async () => {
  const read = await readRecorded('visitor', 'inventory-page-1', 'populated');
  expect(read.requested).toEqual([read.chosen.path]);
  const recorded = read.chosen.answer as PageAnswer;
  const view = mapRecorded(read);
  expect(view.kind).toBe('page');
  if (view.kind !== 'page') return;
  expect(view.workIri).toBe(recorded.work);
  expect(view.complete).toBe(false);
  expect(view.count).toBe(recorded.count.value);
  expect(recorded.count.total).toBeNull();
  expect(view.chapters).toHaveLength(recorded.items.length);
  expect(view.chapters[0]?.label).toBe(chapterLabel(recorded.items[0]));
  expect(view.chapters.at(-1)?.label).toBe(chapterLabel(recorded.items.at(-1)));
  expect(view.nextHref).toContain(continuation(recorded));
  expect(view.chapters[0]?.href).toContain(recorded.items[0]?.occurrence.slice(-36));
  const continued = await readRecorded('visitor', 'inventory-page-10', 'populated');
  expect(continued.requested).toEqual([continued.chosen.path]);
  const continuedView = mapRecorded(continued);
  const continuedAnswer = continued.chosen.answer as PageAnswer;
  expect(continuedView.kind).toBe('page');
  if (continuedView.kind !== 'page') return;
  expect(continuedView.complete).toBe(false);
  expect(continuedView.chapters[0]?.label).toBe(chapterLabel(continuedAnswer.items[0]));
  expect(continuedView.nextHref).toContain(continuation(continuedAnswer));
  const last = await readRecorded('visitor', 'inventory-page-18', 'populated');
  expect(last.requested).toEqual([last.chosen.path]);
  const lastView = mapRecorded(last);
  const lastAnswer = last.chosen.answer as PageAnswer;
  expect(lastView.kind).toBe('page');
  if (lastView.kind !== 'page') return;
  expect(lastView.complete).toBe(true);
  expect(lastView.nextHref).toBeNull();
  expect(lastAnswer.nextCursor).toBeNull();
  expect(lastView.chapters.at(-1)?.label).toBe(chapterLabel(lastAnswer.items.at(-1)));
  expect(lastView.count).toBe(lastAnswer.count.value);
});

test('visitor continuation refusal keeps the recorded problem title', async () => {
  const read = await readRecorded('visitor', 'inventory-page-2', 'error');
  expect(read.requested).toEqual([read.chosen.path]);
  const problem = read.chosen.answer as { title: string; status: number; code: string };
  const view = mapRecorded(read);
  expect(view.kind).toBe('refusal');
  if (view.kind !== 'refusal') return;
  expect(view.title).toBe(problem.title);
  expect(view.failure).toBe('moved');
  expect(problem.status).toBe(409);
  expect(read.answer.error?.status).toBe(409);
  expect(view.restartHref).toContain('/contents');
  expect(view.restartHref).not.toContain('cursor=');
});

test('a primary inventory refusal announces the recorded concealed result and keeps a recovery action', async () => {
  const read = await readRecorded('visitor', 'private-inventory', 'error');
  const view = mapRecorded(read);
  expect(view.kind).toBe('refusal');
  if (view.kind !== 'refusal') return;
  expect(read.answer.error?.status).toBe(404);
  expect(view.failure).toBe('missing');
  expect(view.problem).toEqual(read.chosen.answer);
  const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const render = (selected: BooksContentsRecordedView) => renderToStaticMarkup(createElement(AppRouterContext.Provider,
    { value: router }, createElement(BooksContentsRecordedPage, { view: selected, locale: 'en', messages: messages.en })));
  const html = render(view);
  expect(html).toContain('role="alert"');
  expect(html).toContain(view.title!);
  expect(html).toContain(messages.en.regionMissing);
  expect(html).toContain(messages.en.retry);
  expect(html).not.toContain('<ol');
  expect(html).not.toContain(messages.en.noContents);
  const pending = render({ ...view, failure: 'pending', status: 202 });
  expect(pending).toContain('role="status"');
  expect(pending).not.toContain('role="alert"');
  expect(pending).toContain(messages.en.readPending);
});

test('member work header title is the recorded work title on the inventory page', async () => {
  const inventory = sample('member', 'inventory-page-1');
  const header = sample('member', 'work-header');
  const replay = recordedFetch(record, 'member', [
    { label: 'inventory-page-1', state: 'populated' },
    { label: 'work-header', state: 'populated' },
  ], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const seen: string[] = [];
  const fetcher = watchedFetch(replay, seen);
  const api = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher });
  const { work, query } = booksContentsInventoryQueryFromPath(inventory.path);
  const [answer, headerAnswer] = await Promise.all([
    api.v1['reading-positions']({ work }).get({ query }),
    api.v1.works({ id: work }).get({
      query: { actingSubject: typeof query.actingSubject === 'string' ? query.actingSubject : undefined },
    }),
  ]);
  const requested = seen.map(url => {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/api\/main/, '') + parsed.search;
  });
  expect(requested).toContain(inventory.path);
  expect(requested).toContain(header.path);
  const title = headerAnswer.data?.title;
  expect(title?.value).toBe((header.answer as { title: { value: string } }).title.value);
  const view = mapBooksContentsRecordedPage(answer, {
    workRef: work, workIri: iriOf(work), locale: 'en',
    language: typeof query.language === 'string' ? query.language : undefined,
    title: title ?? null,
  });
  expect(view.kind).toBe('page');
  if (view.kind !== 'page') return;
  expect(view.title?.value).toBe(title?.value);
  expect(view.complete).toBe(false);
  expect(view.nextHref).toContain((inventory.answer as PageAnswer).nextCursor);
});

test('member search with no match is an empty recorded page', async () => {
  const read = await readRecorded('member', 'chapter-search-no-match', 'empty');
  // The record spells the space as + and the typed client sends %20. Replay matches the query value.
  expect(read.chosen.path).toContain('q=unmatched+seed+path');
  expect(read.requested[0]).toContain('q=unmatched%20seed%20path');
  const recorded = read.chosen.answer as PageAnswer;
  const view = mapRecorded(read);
  expect(view.kind).toBe('page');
  if (view.kind !== 'page') return;
  expect(view.chapters).toHaveLength(0);
  expect(view.count).toBe(0);
  expect(recorded.count.value).toBe(0);
  expect(recorded.count.total).toBeNull();
  expect(view.complete).toBe(true);
  expect(view.nextHref).toBeNull();
  expect(recorded.nextCursor).toBeNull();
  expect(view.workIri).toBe(recorded.work);
});

test('entered label and page size select inventory even when legacy grouped contents succeeded', () => {
  expect(contentsReadsInventory({ ok: true, data: {} }, { q: '重逢', limit: 1 })).toBe(true);
  expect(contentsReadsInventory({ ok: true, data: {} }, { limit: 20 })).toBe(true);
  expect(contentsReadsInventory({ ok: true, data: {} }, { q: '999', parent: 'group' })).toBe(false);
});

test('inventory continuation preserves language, entered label and the page size that issued the cursor', async () => {
  const read = await readRecorded('member', 'inventory-page-1', 'populated');
  const view = mapBooksContentsRecordedPage(read.answer, { workRef: read.work, workIri: iriOf(read.work),
    locale: 'en', language: 'ja', q: '再会', limit: 2 });
  expect(view.kind).toBe('page');
  if (view.kind !== 'page') return;
  for (const href of [view.firstHref, view.nextHref!]) {
    const query = new URL(href, 'https://recorded.invalid').searchParams;
    expect(query.get('language')).toBe('ja');
    expect(query.get('q')).toBe('再会');
    expect(query.get('limit')).toBe('2');
  }
  expect(new URL(view.nextHref!, 'https://recorded.invalid').searchParams.get('cursor'))
    .toBe(read.answer.data?.nextCursor ?? null);
});
