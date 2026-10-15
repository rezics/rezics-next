import { afterEach, expect, test } from 'bun:test';
import { answerPersonas, type AnswerPersona, type AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import inventoryRecord from '../../../../tests/qa/fixtures/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import {
  booksContentsInventoryQueryFromPath, mapBooksContentsRecordedPage, readContentsInventory,
  type BooksContentsRecordedView,
} from './books-contents-recorded-page.tsx';
import { iriOf, parseContentsQuery, workHref } from './route.ts';

const record = inventoryRecord as unknown as AnswerRecord;
const distantLabel = 'Episode 1000 重逢';
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

type PageAnswer = {
  work: string;
  items: { occurrence: string; labels?: { value: string; language: string }[]; target?: string; role?: string }[];
  complete: boolean;
  nextCursor: string | null;
  count: { value: number; kind: string; total: null };
  visibility?: string;
  search?: { status: string };
};

type ProblemAnswer = { title: string; status: number; code: string };

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

function chapterLabel(item: PageAnswer['items'][number] | undefined): string {
  const value = item?.labels?.[0]?.value;
  if (!value) throw new Error('recorded episode has no label');
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

function requestedPath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/^\/api\/main/, '') + parsed.search;
}

/** The typed client may spell a query differently. The recorded values stay exact. */
function sameQuery(actual: string, recorded: string): void {
  const left = new URL(actual, 'https://recorded.invalid');
  const right = new URL(recorded, 'https://recorded.invalid');
  const pairs = (url: URL) => [...url.searchParams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  expect(left.pathname).toBe(right.pathname);
  expect(pairs(left)).toEqual(pairs(right));
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
  const requested = seen.map(requestedPath);
  if (state !== 'error' && (answer.error || !answer.data)) {
    const detail = JSON.stringify(answer.error?.value ?? null).slice(0, 500);
    throw new Error(`typed reader rejected ${persona}/${label} (${answer.error?.status ?? 'no data'}): ${detail}`);
  }
  return { chosen, answer, requested, work, query };
}

function mapRecorded(read: Awaited<ReturnType<typeof readRecorded>>): BooksContentsRecordedView {
  return mapBooksContentsRecordedPage(read.answer, {
    workRef: read.work,
    workIri: iriOf(read.work),
    locale: 'en',
    language: typeof read.query.language === 'string' ? read.query.language : undefined,
    q: typeof read.query.q === 'string' ? read.query.q : undefined,
    cursor: typeof read.query.cursor === 'string' ? read.query.cursor : undefined,
    title: null,
  });
}

/** Work id and acting subject are the record's identities. The reader builds the production query itself. */
function identityOf(path: string): { work: string; actingSubject?: string } {
  const url = new URL(path, 'https://recorded.invalid');
  const work = url.pathname.split('/').at(-1) ?? '';
  const actingSubject = url.searchParams.get('actingSubject') ?? undefined;
  return { work, ...(actingSubject ? { actingSubject } : {}) };
}

async function readProductionSearch(persona: AnswerPersona) {
  const chosen = sample(persona, 'distant-episode-search');
  const { work, actingSubject } = identityOf(chosen.path);
  const withHeader = persona === 'owner';
  const replay = recordedFetch(record, persona, [
    ...(withHeader ? [{ label: 'work-header', state: 'populated' as const }] : []),
    { label: 'distant-episode-search', state: 'populated' as const },
  ], { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const seen: string[] = [];
  const main = browserMainApi('https://recorded.invalid', {
    anonymous: !actingSubject, fetcher: watchedFetch(replay, seen),
  });
  const host = { main, ...(actingSubject ? { actingSubject } : {}) };
  const header = withHeader ? await booksEditionReads(host).readWorkHeader(work) : null;
  if (header && !header.ok) throw new Error(`typed reader rejected owner/work-header: ${header.failure}`);
  const view = await readContentsInventory(host, {
    workId: work, workRef: work, workIri: iriOf(work), locale: 'en', language: 'en', q: distantLabel,
    title: header?.ok ? header.data.title : null,
  });
  return { chosen, view, requested: seen.map(requestedPath), title: header?.ok ? header.data.title : null };
}

test('a contents label is kept, and a label longer than the inventory accepts is refused', () => {
  expect(parseContentsQuery({ q: `  ${distantLabel}  `, language: 'EN' })).toEqual({
    parent: undefined, language: 'en', cursor: undefined, q: distantLabel,
  });
  expect(parseContentsQuery({})).toEqual({ parent: undefined, language: undefined, cursor: undefined });
  expect(parseContentsQuery({ q: '   ' })).toEqual({ parent: undefined, language: undefined, cursor: undefined });
  expect(parseContentsQuery({ q: 'x'.repeat(201) })).toBeNull();
  expect(parseContentsQuery({ q: [distantLabel, distantLabel] })).toBeNull();
  const continued = workHref('work', 'contents', null, { language: 'en', q: distantLabel, cursor: 'opaque' });
  expect(continued).toContain('q=');
  expect(continued).toContain('cursor=opaque');
  expect(workHref('work', 'contents', null, { language: 'en', q: distantLabel })).not.toContain('cursor=');
});

test('each persona reaches the recorded label search at the production page size', async () => {
  for (const persona of answerPersonas) {
    const read = await readProductionSearch(persona);
    expect(read.requested.at(-1)).toBeTruthy();
    sameQuery(read.requested.at(-1)!, read.chosen.path);
    expect(read.requested.at(-1)).toContain('limit=100');
    expect(read.requested.at(-1)).not.toContain('limit=2');
    const recorded = read.chosen.answer as PageAnswer;
    const view = read.view;
    expect(view.kind).toBe('page');
    if (view.kind !== 'page') return;
    expect(view.q).toBe(distantLabel);
    expect(recorded.visibility).toBe('pending');
    expect(recorded.search).toEqual({ status: 'current' });
    expect(recorded.items).toHaveLength(0);
    expect(recorded.count).toEqual({ value: 0, kind: 'exact-page', total: null });
    expect(view.chapters).toHaveLength(0);
    expect(view.count).toBe(0);
    expect(view.complete).toBe(false);
    expect(recorded.complete).toBe(false);
    expect(view.nextHref).toContain(continuation(recorded));
    expect(view.nextHref).toContain(`q=${encodeURIComponent(distantLabel).replace(/%20/g, '+')}`);
    expect(view.firstHref).toContain('q=');
    expect(view.firstHref).not.toContain('cursor=');
    expect(view.searchHref).not.toContain('q=');
    expect(view.searchHref).not.toContain('cursor=');
    if (persona === 'owner') {
      const title = (sample('owner', 'work-header').answer as { title: { value: string } }).title.value;
      expect(read.requested).toHaveLength(2);
      expect(read.title?.value).toBe(title);
      expect(view.title?.value).toBe(title);
    } else {
      expect(read.requested).toHaveLength(1);
      expect(view.title).toBeNull();
    }
  }
});

test('each persona keeps the recorded episode pages and their opaque continuation', async () => {
  for (const persona of answerPersonas) {
    const read = await readRecorded(persona, 'inventory-start', 'populated');
    expect(read.requested).toHaveLength(1);
    sameQuery(read.requested[0]!, read.chosen.path);
    const recorded = read.chosen.answer as PageAnswer;
    const view = mapRecorded(read);
    expect(view.kind).toBe('page');
    if (view.kind !== 'page') return;
    expect(view.workIri).toBe(recorded.work);
    expect(view.complete).toBe(false);
    expect(recorded.complete).toBe(false);
    expect(view.count).toBe(recorded.count.value);
    expect(recorded.count).toEqual({ value: recorded.items.length, kind: 'exact-page', total: null });
    expect(view.chapters).toHaveLength(recorded.items.length);
    expect(view.chapters[0]?.label).toBe(chapterLabel(recorded.items[0]));
    expect(view.chapters.at(-1)?.label).toBe(chapterLabel(recorded.items.at(-1)));
    expect(chapterLabel(recorded.items[0])).toBe('Episode 1');
    expect(chapterLabel(recorded.items.at(-1))).toBe('Episode 2');
    expect(view.nextHref).toContain(continuation(recorded));
    expect(view.nextHref).not.toContain('q=');
    expect(view.chapters[0]?.occurrence).toBe(recorded.items[0]?.occurrence);
    if (recorded.items[0]?.role === 'part') expect(view.chapters[0]?.href).toBe(workHref(recorded.items[0]!.target!.slice(-36)));
    else expect(view.chapters[0]?.href).toContain(recorded.items[0]?.occurrence.slice(-36));
    const continued = await readRecorded(persona, 'inventory-continuation', 'populated');
    expect(continued.requested).toHaveLength(1);
    sameQuery(continued.requested[0]!, continued.chosen.path);
    expect(continued.query.cursor).toBe(continuation(recorded));
    const continuedView = mapRecorded(continued);
    const continuedAnswer = continued.chosen.answer as PageAnswer;
    expect(continuedView.kind).toBe('page');
    if (continuedView.kind !== 'page') return;
    expect(continuedView.complete).toBe(false);
    expect(continuedAnswer.complete).toBe(false);
    expect(continuedView.chapters[0]?.label).toBe('Episode 3');
    expect(continuedView.chapters.at(-1)?.label).toBe('Episode 4');
    expect(continuedView.nextHref).toContain(continuation(continuedAnswer));
    expect(continuedView.count).toBe(continuedAnswer.count.value);
    expect(continuedAnswer.count.total).toBeNull();
  }
});

test('a pending search page keeps its continuation and is not a finished inventory', async () => {
  for (const label of ['inventory-search-empty'] as const) {
    const read = await readRecorded('visitor', label, 'populated');
    sameQuery(read.requested[0]!, read.chosen.path);
    const recorded = read.chosen.answer as PageAnswer;
    const view = mapRecorded(read);
    expect(view.kind).toBe('page');
    if (view.kind !== 'page') return;
    expect(recorded.visibility).toBe('pending');
    expect(recorded.search).toEqual({ status: 'current' });
    expect(recorded.items).toHaveLength(0);
    expect(recorded.count).toEqual({ value: 0, kind: 'exact-page', total: null });
    expect(view.chapters).toHaveLength(0);
    expect(view.count).toBe(0);
    expect(view.complete).toBe(false);
    expect(recorded.complete).toBe(false);
    expect(view.nextHref).toContain(continuation(recorded));
  }
});

test('visitor continuation refusal keeps the recorded problem title', async () => {
  const read = await readRecorded('visitor', 'cursor-query-refused', 'error');
  sameQuery(read.requested[0]!, read.chosen.path);
  const problem = read.chosen.answer as ProblemAnswer;
  const view = mapRecorded(read);
  expect(view.kind).toBe('refusal');
  if (view.kind !== 'refusal') return;
  expect(view.title).toBe(problem.title);
  expect(problem.title).toBe('Cursor is invalid or expired');
  expect(view.failure).toBe('invalid');
  expect(problem.status).toBe(400);
  expect(problem.code).toBe('invalid_work_read');
  expect(read.answer.error?.status).toBe(400);
  expect(view.restartHref).toContain('/contents');
  expect(view.restartHref).toContain('q=Episode+8');
  expect(view.restartHref).not.toContain('cursor=');
});

test('a private inventory is the owner empty page and a refusal for everyone else', async () => {
  const owner = await readRecorded('owner', 'private-inventory', 'empty');
  sameQuery(owner.requested[0]!, owner.chosen.path);
  const recorded = owner.chosen.answer as PageAnswer;
  const view = mapRecorded(owner);
  expect(view.kind).toBe('page');
  if (view.kind !== 'page') return;
  expect(recorded.visibility).toBe('empty');
  expect(view.chapters).toHaveLength(0);
  expect(view.count).toBe(0);
  expect(recorded.count).toEqual({ value: 0, kind: 'exact-page', total: null });
  expect(view.complete).toBe(true);
  expect(view.nextHref).toBeNull();
  expect(recorded.nextCursor).toBeNull();
  expect(view.workIri).toBe(recorded.work);
  for (const persona of answerPersonas) {
    if (persona === 'owner') continue;
    const refused = await readRecorded(persona, 'private-inventory-refused', 'error');
    sameQuery(refused.requested[0]!, refused.chosen.path);
    const problem = refused.chosen.answer as ProblemAnswer;
    const refusal = mapRecorded(refused);
    expect(refusal.kind).toBe('refusal');
    if (refusal.kind !== 'refusal') return;
    expect(refusal.title).toBe(problem.title);
    expect(problem.title).toBe('Resource is unavailable');
    expect(refusal.failure).toBe('missing');
    expect(problem.status).toBe(404);
    expect(problem.code).toBe('work_unavailable');
    expect(refused.answer.error?.status).toBe(404);
  }
});

test('owner work header title is the recorded work title on the inventory page', async () => {
  const inventory = sample('owner', 'inventory-start');
  const header = sample('owner', 'work-header');
  const replay = recordedFetch(record, 'owner', [
    { label: 'inventory-start', state: 'populated' },
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
  if (answer.error || !answer.data) {
    throw new Error(`typed reader rejected owner/inventory-start: ${JSON.stringify(answer.error?.value ?? null).slice(0, 500)}`);
  }
  if (headerAnswer.error || !headerAnswer.data) {
    throw new Error(`typed reader rejected owner/work-header: ${JSON.stringify(headerAnswer.error?.value ?? null).slice(0, 500)}`);
  }
  const requested = seen.map(requestedPath);
  const inventoryRequest = requested.find(path => path.includes('/reading-positions/'));
  const headerRequest = requested.find(path => path.includes('/works/'));
  if (!inventoryRequest || !headerRequest) throw new Error(`recorded requests missing: ${requested.join(' | ')}`);
  sameQuery(inventoryRequest, inventory.path);
  sameQuery(headerRequest, header.path);
  const title = headerAnswer.data.title;
  expect(title?.value).toBe((header.answer as { title: { value: string } }).title.value);
  const view = mapBooksContentsRecordedPage(answer, {
    workRef: work, workIri: iriOf(work), locale: 'en',
    language: typeof query.language === 'string' ? query.language : undefined,
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    title: title ?? null,
  });
  expect(view.kind).toBe('page');
  if (view.kind !== 'page') return;
  expect(view.title?.value).toBe(title?.value);
  expect(view.complete).toBe(false);
  expect(view.nextHref).toContain((inventory.answer as PageAnswer).nextCursor);
  expect(typeof query.actingSubject).toBe('string');
});

function numbered(label: string, prefix: string): number {
  return Number(label.slice(prefix.length));
}

/** Successful limit=100 inventory windows, in the order the page followed. */
function inventoryWindows(persona: AnswerPersona) {
  return record.personas[persona]
    .filter(item => /^inventory-read-\d+$/.test(item.label) && item.status === 200)
    .sort((left, right) => numbered(left.label, 'inventory-read-') - numbered(right.label, 'inventory-read-'));
}

function searchWindows(persona: AnswerPersona) {
  return record.personas[persona]
    .filter(item => item.status === 200 && (item.label === 'distant-episode-search' || /^distant-episode-window-\d+$/.test(item.label)))
    .sort((left, right) => (left.label === 'distant-episode-search' ? 1 : numbered(left.label, 'distant-episode-window-'))
      - (right.label === 'distant-episode-search' ? 1 : numbered(right.label, 'distant-episode-window-')));
}

function contentsLabelForInventory(path: string, label: string): string {
  return new URL(path, 'https://recorded.invalid').searchParams.has('cursor')
    ? `inventory-contents-${numbered(label, 'inventory-read-')}` : 'selected-language-contents';
}

function contentsLabelForSearch(label: string): string {
  return label === 'distant-episode-search'
    ? 'selected-language-contents' : `distant-episode-contents-${numbered(label, 'distant-episode-window-')}`;
}

test('each persona follows the recorded inventory and the search cursor to the distant episode', async () => {
  for (const persona of answerPersonas) {
    const windows = inventoryWindows(persona);
    expect(windows.length).toBeGreaterThan(1);
    let previous: string | null = null;
    let seen = 0;
    for (const [index, item] of windows.entries()) {
      const answer = item.answer as PageAnswer;
      const url = new URL(item.path, 'https://recorded.invalid');
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('q')).toBeNull();
      expect(url.searchParams.get('cursor')).toBe(previous);
      expect(answer.count).toEqual({ value: answer.items.length, kind: 'exact-page', total: null });
      expect(answer.complete).toBe(answer.nextCursor === null);
      if (index === 0) expect(chapterLabel(answer.items[0])).toBe('Episode 1');
      seen += answer.items.length;
      previous = answer.nextCursor;
      const contents = sample(persona, contentsLabelForInventory(item.path, item.label));
      const replay = recordedFetch(record, persona, [
        { label: contents.label, state: contents.status === 200 ? 'populated' : 'error' },
        { label: item.label, state: 'populated' },
      ], { pathPrefix: BFF_PREFIX });
      disposals.push(replay.dispose);
      const seenRequests: string[] = [];
      const actingSubject = url.searchParams.get('actingSubject') ?? undefined;
      const main = browserMainApi('https://recorded.invalid', {
        anonymous: !actingSubject, fetcher: watchedFetch(replay, seenRequests),
      });
      const host = { main, ...(actingSubject ? { actingSubject } : {}) };
      const cursor = url.searchParams.get('cursor') ?? undefined;
      await main.v1.works({ id: url.pathname.split('/').at(-1)! }).contents.get({
        query: { actingSubject, language: 'en', ...(cursor ? { cursor } : {}) },
      });
      const view = await readContentsInventory(host, {
        workId: url.pathname.split('/').at(-1)!, workRef: url.pathname.split('/').at(-1)!,
        workIri: iriOf(url.pathname.split('/').at(-1)!), locale: 'en', language: 'en', cursor,
      });
      const requested = seenRequests.map(requestedPath);
      expect(requested).toHaveLength(2);
      sameQuery(requested[1]!, item.path);
      expect(view.kind).toBe('page');
    }
    expect(previous).toBeNull();
    expect(seen).toBe(1000);
    expect(chapterLabel((windows.at(-1)!.answer as PageAnswer).items.at(-1))).toBe(distantLabel);

    const search = searchWindows(persona);
    expect(search.length).toBeGreaterThan(1);
    let searchCursor: string | null = null;
    for (const item of search) {
      const url = new URL(item.path, 'https://recorded.invalid');
      expect(url.searchParams.get('q')).toBe(distantLabel);
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('cursor')).toBe(searchCursor);
      searchCursor = (item.answer as PageAnswer).nextCursor;
    }
    const visible = search.find(item => (item.answer as PageAnswer).items.length > 0);
    if (!visible) throw new Error(`${persona} search never reached ${distantLabel}`);
    expect(chapterLabel((visible.answer as PageAnswer).items.find(item => chapterLabel(item) === distantLabel))).toBe(distantLabel);
    const visibleUrl = new URL(visible.path, 'https://recorded.invalid');
    const contents = sample(persona, contentsLabelForSearch(visible.label));
    const actingSubject = visibleUrl.searchParams.get('actingSubject') ?? undefined;
    const replay = recordedFetch(record, persona, [
      { label: contents.label, state: contents.status === 200 ? 'populated' : 'error' },
      { label: visible.label, state: 'populated' },
    ], { pathPrefix: BFF_PREFIX });
    disposals.push(replay.dispose);
    const seenRequests: string[] = [];
    const main = browserMainApi('https://recorded.invalid', {
      anonymous: !actingSubject, fetcher: watchedFetch(replay, seenRequests),
    });
    const cursor = visibleUrl.searchParams.get('cursor') ?? undefined;
    const host = { main, ...(actingSubject ? { actingSubject } : {}) };
    await main.v1.works({ id: visibleUrl.pathname.split('/').at(-1)! }).contents.get({
      query: { actingSubject, language: 'en', ...(cursor ? { cursor } : {}) },
    });
    const view = await readContentsInventory(host, {
      workId: visibleUrl.pathname.split('/').at(-1)!, workRef: visibleUrl.pathname.split('/').at(-1)!,
      workIri: iriOf(visibleUrl.pathname.split('/').at(-1)!), locale: 'en', language: 'en',
      q: distantLabel, cursor,
    });
    const requested = seenRequests.map(requestedPath);
    expect(requested).toHaveLength(2);
    sameQuery(requested[0]!, contents.path);
    sameQuery(requested[1]!, visible.path);
    expect(view.kind).toBe('page');
    if (view.kind !== 'page') return;
    expect(view.chapters.some(chapter => chapter.label === distantLabel)).toBe(true);
    expect(view.q).toBe(distantLabel);
    if (cursor) expect(view.firstHref).toContain('q=');
    expect(view.firstHref).not.toContain('cursor=');
  }
});
