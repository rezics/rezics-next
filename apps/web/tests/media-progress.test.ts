import { describe, expect, test } from 'bun:test';
import { progressControl } from '../features/tracking/medium-progress.tsx';
import type { MainClient } from '../features/discover/types.ts';
import { CHAPTER_COVERAGE_PAGE_LIMIT, chapterCompletionOf, mainMediaApi, type MediaApi, workProgressConflict } from '../features/tracking/media-api.ts';
import { chapterPosition, flattenChapters, gameStatus, mediumOf, resumeAt, resumeName, type ChapterRef } from '../features/tracking/media.ts';

const chapter = (volume: number, number: number, id = `${volume}-${number}`): ChapterRef => ({
  volume: { number: volume, label: String(volume) },
  number, occurrence: `https://example.test/occ/${id}`, structure: 'https://example.test/book', label: null,
});

describe('chapter completion coverage', () => {
  const place = (volume: number, number: number) => ({ ...chapter(volume, number), label: `Chapter ${number}` });
  const work = 'https://rezics.com/id/00000000-0000-7000-8000-000000000001';
  const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000002';
  const occurrence = (number: number) => `https://rezics.com/id/00000000-0000-7000-8000-${String(number + 100).padStart(12, '0')}`;

  function main(done: number[], page = 3) {
    const rows = new Set(done.map(occurrence));
    const items = Array.from({ length: 12 }, (_, index) => ({
      occurrence: occurrence(index + 1), structure, role: 'chapter', displayLabel: `Chapter ${index + 1}`,
    }));
    const calls: string[] = [];
    const client = { v1: {
      'reading-positions': () => ({ get: async ({ query }: { query: { position: string; around?: string; cursor?: string } }) => {
        calls.push(query.around ? 'neighbour' : query.position);
        const last = items.findLastIndex(item => rows.has(item.occurrence));
        if (query.around) return { data: { items: items.slice(last + 1, last + 2),
          neighbours: { next: last === 11 ? { status: 'none' } : { status: 'found', occurrence: items[last + 1]!.occurrence } } }, error: null };
        if (query.position === 'mine' && last >= 0) return { data: { scope: 'resume', resolved: items[last]!.occurrence,
          items: [items[last]!] }, error: null };
        const from = Number(query.cursor ?? 0);
        const next = from + page < items.length ? String(from + page) : null;
        return { data: { scope: 'positions', resolved: 'start', items: items.slice(from, from + page), nextCursor: next, complete: next === null }, error: null };
      } }),
      compositions: () => ({ progress: { get: async ({ query }: { query: { cursor?: string } }) => {
        calls.push('completions');
        const completed = [...rows].map(id => ({ occurrence: id, completed: true }));
        const from = Number(query.cursor ?? 0);
        const next = from + page < completed.length ? String(from + page) : null;
        return { data: { items: completed.slice(from, from + page), nextCursor: next, complete: next === null }, error: null };
      } } }),
    } } as unknown as MainClient;
    return { api: mainMediaApi(work, () => client), rows, calls };
  }

  for (const last of [6, 12]) {
    test(`chapters 1 and ${last} retain resume without claiming all chapters read`, async () => {
      const { api } = main([1, last]);
      const read = await api.standing(work);
      expect(read).toMatchObject({ ok: true, data: { caughtUp: false, last: { occurrence: occurrence(last) },
        next: last === 12 ? null : { occurrence: occurrence(7) } } });
    });
  }

  test('unmarking chapter 2 invalidates previously complete coverage', async () => {
    const { api, rows } = main(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await api.standing(work)).toMatchObject({ ok: true, data: { caughtUp: true } });
    rows.delete(occurrence(2));
    expect(await api.standing(work)).toMatchObject({ ok: true, data: { caughtUp: false, last: { occurrence: occurrence(12) } } });
  });

  test('a gap after a completed position page breaks coverage', async () => {
    const { api } = main([1, 2, 3, 5, 6, 12]);
    expect(await api.standing(work)).toMatchObject({ ok: true, data: { caughtUp: false } });
  });

  test('proof crosses empty continuation pages and volume structures', async () => {
    const api: Pick<MediaApi, 'positions' | 'completions'> = {
      positions: async (_work, cursor) => ({ ok: true, data: cursor
        ? { items: [place(2, 1)], next: null, complete: true }
        : { items: [], next: 'volume', complete: false } }),
      completions: async (_structure, cursor) => ({ ok: true, data: cursor
        ? { occurrences: [chapter(2, 1).occurrence], next: null, complete: true }
        : { occurrences: [], next: 'readable', complete: false } }),
    };
    expect(await chapterCompletionOf(api, work)).toEqual({ ok: true, data: true });
    const both = { ...api, positions: async () => ({ ok: true as const, data: {
      items: [{ ...place(1, 1), structure: 'volume-one' }, { ...place(2, 1), structure: 'volume-two' }], next: null, complete: true,
    } }), completions: async (volume: string) => ({ ok: true as const, data: {
      occurrences: [chapter(volume === 'volume-one' ? 1 : 2, 1).occurrence], next: null, complete: true,
    } }) };
    expect(await chapterCompletionOf(both, work)).toEqual({ ok: true, data: true });
  });

  test('budget exhaustion and a terminal incomplete inventory leave coverage unknown', async () => {
    let calls = 0;
    const api: Pick<MediaApi, 'positions' | 'completions'> = {
      positions: async () => ({ ok: true, data: { items: [], next: String(++calls), complete: false } }),
      completions: async () => { throw new Error('No chapters were enumerated'); },
    };
    expect(await chapterCompletionOf(api, work)).toEqual({ ok: true, data: null });
    expect(calls).toBe(CHAPTER_COVERAGE_PAGE_LIMIT);
    expect(await chapterCompletionOf({ ...api, positions: async () => ({ ok: true,
      data: { items: [], next: null, complete: false } }) }, work)).toEqual({ ok: true, data: null });
  });

  test('completion-page bounds, cycles and denied reads cannot establish coverage', async () => {
    let calls = 0;
    const api: Pick<MediaApi, 'positions' | 'completions'> = {
      positions: async () => ({ ok: true, data: { items: [place(1, 1)], next: null, complete: true } }),
      completions: async () => ({ ok: true, data: { occurrences: [], next: String(++calls), complete: false } }),
    };
    expect(await chapterCompletionOf(api, work)).toEqual({ ok: true, data: null });
    expect(calls).toBe(CHAPTER_COVERAGE_PAGE_LIMIT - 1);
    expect(await chapterCompletionOf({ ...api, completions: async () => ({ ok: true,
      data: { occurrences: [], next: 'cycle', complete: false } }) }, work)).toEqual({ ok: true, data: null });
    expect(await chapterCompletionOf({ ...api, completions: async () => ({ ok: true,
      data: { occurrences: [], next: null, complete: false } }) }, work)).toEqual({ ok: true, data: null });
    expect(await chapterCompletionOf({ ...api, completions: async () => ({ ok: false, failure: 'closed' }) }, work))
      .toEqual({ ok: false, failure: 'closed' });
  });
});

describe('medium progress', () => {
  test('the served presentation and the structure choose the control', () => {
    const bare = { volumes: false, chapters: false };
    expect(mediumOf('game', bare)).toBe('game');
    expect(mediumOf('game', { volumes: true, chapters: false })).toBe('game');
    expect(mediumOf('media', { volumes: false, chapters: true })).toBe('episodes');
    expect(mediumOf('book', bare)).toBe('chapters');
    expect(mediumOf(null, { volumes: true, chapters: false })).toBe('chapters');
    expect(mediumOf(null, { volumes: false, chapters: true })).toBe('chapters');
    expect(mediumOf(null, bare)).toBe('episodes');
  });

  test('a chapter inside a volume, and the same chapter in an omnibus, resume at the next one', () => {
    const series = flattenChapters([
      { number: 1, label: '1', chapters: [chapter(1, 1), chapter(1, 2)] },
      { number: 2, label: '2', chapters: [chapter(2, 3, 'shared'), chapter(2, 4)] },
    ]);
    const omnibus = flattenChapters([
      { number: 1, label: '2', chapters: [chapter(2, 3, 'shared'), chapter(2, 4)] },
    ]);
    const shared = 'https://example.test/occ/shared';
    expect(resumeAt(series, shared, new Set([shared]))).toMatchObject({
      last: { occurrence: shared }, next: { occurrence: 'https://example.test/occ/2-4' },
    });
    expect(resumeAt(omnibus, shared, new Set([shared])).next?.occurrence)
      .toBe(resumeAt(series, shared, new Set([shared])).next?.occurrence);
    expect(chapterPosition(series[2]!)).toBe('chapter:2:3');
  });

  test('a resume item names its chapter or episode when that part is past the loaded page', () => {
    const loaded = flattenChapters([{ number: 1, label: '1', chapters: [chapter(1, 1), chapter(1, 2)] }]);
    const stopped = 'https://example.test/occ/1150';
    expect(loaded.some(item => item.occurrence === stopped)).toBe(false);
    expect(resumeName({ displayLabel: 'Chapter 1150', labels: [{ value: 'Chapter 1150' }] })).toBe('Chapter 1150');
    expect(resumeName({ labels: [{ value: 'Chapter 1150' }] })).toBe('Chapter 1150');
    expect(resumeName({ displayLabel: 'Episode 1002' })).toBe('Episode 1002');
    expect(resumeName({ labels: [] })).toBeNull();
    expect(resumeName({})).toBeNull();
    expect(resumeName(null)).toBeNull();
  });

  test('a book of volume groups, and a book with an empty composition, keep the chapter panel', async () => {
    let asked = 0;
    const api = {
      routes: async () => { asked++; return { ok: true as const, data: { items: [], next: null } }; },
      workParts: async () => { asked++; return { ok: true as const, data: false }; },
    };
    const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
    // The first page of a nested book is volume groups, so a chapter list and a volume list are both empty.
    expect(await progressControl(api, null, work, 'book')).toEqual({ kind: 'chapters' });
    // An empty BookComposition lists nothing either. The book presentation is enough.
    expect(await progressControl(api, null, work, 'book')).toEqual({ kind: 'chapters' });
    expect(asked).toBe(0);
  });

  test('a Work whose progress read says it has parts uses the chapter panel', async () => {
    const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
    const api = {
      routes: async () => { throw new Error('contents pages are not the parts check'); },
      workParts: async () => ({ ok: true as const, data: true }),
    };
    expect(await progressControl(api, null, work, null)).toEqual({ kind: 'chapters' });
    expect(await progressControl({ ...api, workParts: async () => ({ ok: false as const, failure: 'unavailable' as const }) },
      null, work, null)).toEqual({ kind: 'chapters' });
    expect(await progressControl({ ...api, workParts: async () => ({ ok: true as const, data: false }) },
      null, work, null)).toEqual({ kind: 'work', verb: 'read' });
  });

  test('work_has_parts is the parts answer, and a moved graph is the conflict that can restart', () => {
    expect(workProgressConflict(409, { code: 'work_has_parts' })).toBe('parts');
    expect(workProgressConflict(409, { code: 'read_basis_changed' })).toBe('other');
    expect(workProgressConflict(409, { code: 'stale_progress' })).toBe('other');
    expect(workProgressConflict(404, { code: 'work_has_parts' })).toBeNull();
  });

  test('a game is completed from its required parts, and a route alone leaves it played', () => {
    const story = { required: true, completed: true, started: true };
    const route = { required: false, completed: false, started: false };
    expect(gameStatus([story, route])).toBe('completed');
    expect(gameStatus([{ ...story, completed: false }, { ...route, completed: true, started: true }])).toBe('played');
    expect(gameStatus([])).toBe('none');
    expect(gameStatus([{ required: true, completed: null }], false)).toBe('unknown');
  });
});
