import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { MainClient } from '../discover/types.ts';
import { workHref } from '../work-page/route.ts';
import { parseLibraryState } from './state.ts';

const originalReader = { ...(await import('../shell/communities-read.ts')) };
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const works = Array.from({ length: 8 }, (_, index) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const requested: string[] = [];
const totals: string[] = [];
let rankedReads = 0;
let unavailable: string | null = null;
let complete: string | null = null;
let lowerBound: string | null = null;

const answer = (data: unknown) => Promise.resolve({ data, error: null });
const resume = (work: string) => ({ work, nextUnread: work === complete ? null : {
  title: `Chapter ${works.indexOf(work) + 2}`,
  href: `${workHref(work.slice(-36))}/read/chapter-${works.indexOf(work) + 2}?language=zh-Hans`,
}, unreadCount: work === complete ? null : { value: 8 - works.indexOf(work),
  kind: work === lowerBound ? 'lower-bound' as const : 'exact' as const } });
const shelf = (limit: number) => answer({ items: works.slice(0, limit).map(work => ({ work, status: 'reading',
  version: 1, changedAt: null, startedOn: null, finishedOn: null, card: { id: work, title: null, cover: null,
    types: ['https://schema.org/Book'] } })), nextCursor: null });
const main = { v1: {
  me: {
    shelves: Object.assign(() => ({}), { get: () => answer({ items: [],
      statusShelves: [{ status: 'reading', count: 8 }] }),
    status: () => ({ works: { get: ({ query }: { query: { limit: number } }) => shelf(query.limit) } }) }),
    'work-states': { get: () => answer({ items: [] }) },
    continue: Object.assign(({ work: id }: { work: string }) => ({ get: () => {
      const work = works.find(item => item.endsWith(id))!;
      requested.push(work);
      return work === unavailable ? Promise.reject(new Error('network')) : answer(resume(work));
    } }), { get: () => { rankedReads++; return answer({ items: works.slice(0, 6).map(resume) }); } }),
    'import-reviews': { get: () => answer({ items: [] }) },
  },
  works: ({ id }: { id: string }) => ({ get: () => { totals.push(id); return answer({ chapterCount: 10 }); } }),
  agents: () => ({ 'library-visibility': { get: () => answer({ visibility: 'private' }) } }),
  'rating-contexts': { get: () => answer({ items: [] }) },
} } as unknown as MainClient;

const restoreOriginalReader = replaceModule(import.meta.resolve('../shell/communities-read.ts'), originalReader, {
  shellReader: async () => ({ signedIn: true, actingSubject: agent, main, anonymous: main, avatarQuery: '' }),
});
afterAll(async () => { restoreOriginalReader(); });
beforeEach(() => {
  requested.length = 0; totals.length = 0; rankedReads = 0;
  unavailable = null; complete = null; lowerBound = null;
});

const { readShelfView, readCurrentlyReading, readCustomShelves } = await import('./read.ts');
const state = parseLibraryState({ shelf: 'reading' });

test('a bounded directory forwards every opaque cursor and returns the last remainder', async () => {
  const cursors = ['opaque:+/%?=1', 'opaque:+/%?=2', 'opaque:+/%?=3', 'opaque:+/%?=4', 'opaque:+/%?=5'];
  const seen: (string | undefined)[] = [];
  const directory = { v1: { me: { shelves: { get: ({ query }: { query: { cursor?: string } }) => {
    seen.push(query.cursor);
    return answer({ items: [{ id: String(seen.length) }], statusShelves: [],
      nextCursor: cursors[seen.length - 1] });
  } } } } } as unknown as MainClient;
  const result = await readCustomShelves(directory, agent);
  expect(seen).toEqual([undefined, ...cursors.slice(0, 4)]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data.items).toHaveLength(5);
    expect(result.data.nextCursor).toBe(cursors[4]!);
  }
});

test('a failed later directory page stays a failure rather than a complete partial list', async () => {
  let calls = 0;
  const directory = { v1: { me: { shelves: { get: () => ++calls === 1
    ? answer({ items: [], statusShelves: [], nextCursor: 'opaque-next' })
    : Promise.reject(new Error('unavailable')) } } } } as unknown as MainClient;
  expect(await readCustomShelves(directory, agent)).toEqual({ ok: false, failure: 'unavailable' });
});

test('a directory that ends after several pages keeps its terminal continuation', async () => {
  let calls = 0;
  const directory = { v1: { me: { shelves: { get: () => answer({ items: [], statusShelves: [],
    nextCursor: ++calls === 1 ? 'opaque-next' : null }) } } } } as unknown as MainClient;
  const result = await readCustomShelves(directory, agent);
  expect(calls).toBe(2);
  expect(result.ok && result.data.nextCursor).toBeNull();
});

test('each of eight reading Works keeps its own Continue at its exact position', async () => {
  const view = await readShelfView(state, 'en');
  expect(view.ok).toBe(true);
  if (!view.ok) return;
  expect(view.data.rows.map(row => row.progress)).toEqual(works.map((work, index) => ({
    next: resume(work).nextUnread,
    left: resume(work).unreadCount,
    chapters: { read: index + 2, total: 10 },
  })));
  expect(requested.toSorted()).toEqual(works.toSorted());
  expect(rankedReads).toBe(0);
});

test('the All preview reads each displayed Work directly', async () => {
  const rows = await readCurrentlyReading('en');
  expect(rows.map(row => row.progress?.next?.href)).toEqual(works.slice(0, 3).map(work => resume(work).nextUnread?.href));
  expect(requested).toEqual(works.slice(0, 3));
  expect(rankedReads).toBe(0);
});

test('a failed or completed resume leaves other rows resumable, and lower bounds stay inexact', async () => {
  unavailable = works[0]!; complete = works[1]!; lowerBound = works[2]!;
  const view = await readShelfView(state, 'en');
  expect(view.ok).toBe(true);
  if (!view.ok) return;
  expect(view.data.rows[0]!.progress).toEqual({ next: null, left: null, chapters: null });
  expect(view.data.rows[1]!.progress).toEqual({ next: null, left: null, chapters: null });
  expect(view.data.rows[2]!.progress).toEqual({ next: resume(works[2]!).nextUnread,
    left: { value: 6, kind: 'lower-bound' }, chapters: null });
  expect(view.data.rows[7]!.progress?.next?.href).toBe(resume(works[7]!).nextUnread?.href);
  expect(totals).toHaveLength(5);
});
