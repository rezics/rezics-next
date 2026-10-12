import { describe, expect, test } from 'bun:test';
import { progressControl } from '../features/tracking/medium-progress.tsx';
import type { MainClient } from '../features/discover/types.ts';
import { mainMediaApi, workProgressConflict } from '../features/tracking/media-api.ts';
import { chapterProgressWhere } from '../features/tracking/chapter-progress.tsx';
import { copyOf } from '../features/tracking/messages.ts';
import { chapterPosition, flattenChapters, gameStatus, mediumOf, resumeAt, resumeName, type ChapterRef } from '../features/tracking/media.ts';

const chapter = (volume: number, number: number, id = `${volume}-${number}`): ChapterRef => ({
  volume: { number: volume, label: String(volume) },
  number, occurrence: `https://example.test/occ/${id}`, structure: 'https://example.test/book', label: null,
});

describe('chapter completion coverage', () => {
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
          items: [items[last]!], complete: true }, error: null };
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
      expect(read).toMatchObject({ ok: true, data: { last: { occurrence: occurrence(last) },
        next: null } });
    });
  }

  test('unmarking chapter 2 invalidates previously complete coverage', async () => {
    const { api, rows, calls } = main(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await api.standing(work)).toMatchObject({ ok: true, data: { last: { occurrence: occurrence(12) }, next: null } });
    rows.delete(occurrence(2));
    calls.length = 0;
    expect(await api.standing(work)).toMatchObject({ ok: true, data: { last: { occurrence: occurrence(12) } } });
    expect(calls).toEqual(['mine']);
  });

  test('a gap after a completed position page breaks coverage', async () => {
    const { api } = main([1, 2, 3, 5, 6, 12]);
    const read = await api.standing(work);
    expect(read).toMatchObject({ ok: true, data: { last: { occurrence: occurrence(12) }, next: null } });
    if (read.ok) expect(read.data).not.toHaveProperty('caughtUp');
  });

  test('concurrent unmark and mark across volumes cannot mix separate coverage reads', async () => {
    const calls: string[] = [];
    const chapterOne = { structure: 'https://example.test/volume-one', occurrence: 'https://example.test/chapter-one',
      role: 'chapter', displayLabel: 'Volume 1, chapter 1' };
    const chapterTwo = { ...chapterOne, structure: 'https://example.test/volume-two', occurrence: 'https://example.test/chapter-two',
      displayLabel: 'Volume 2, chapter 1' };
    let furthest = chapterOne;
    const client = { v1: {
      'reading-positions': () => ({ get: async ({ query }: { query: { around?: string; position: string } }) => {
        calls.push(query.around ? 'neighbour' : query.position);
        if (query.around) {
          furthest = chapterTwo;
          return { data: { items: [], neighbours: { next: { status: 'none' } } }, error: null };
        }
        return { data: { scope: 'resume', resolved: furthest.occurrence, items: [furthest], complete: true }, error: null };
      } }),
      compositions: () => ({ progress: { get: async () => {
        calls.push('completions');
        return { data: { items: [{ occurrence: chapterTwo.occurrence }], nextCursor: null, complete: true }, error: null };
      } } }),
    } } as unknown as MainClient;
    const read = await mainMediaApi(work, () => client).standing(work);
    expect(read).toMatchObject({ ok: true, data: { last: { occurrence: chapterOne.occurrence }, next: null } });
    if (read.ok) expect(read.data).not.toHaveProperty('caughtUp');
    expect(calls).toEqual(['mine']);
  });

  for (const response of [
    { scope: 'positions', resolved: 'start', complete: true, items: [], nextCursor: null },
    { scope: 'positions', resolved: occurrence(1), complete: true,
      items: [{ occurrence: occurrence(1), structure, role: 'chapter', displayLabel: 'Chapter 1' }], nextCursor: null },
    { scope: 'resume', resolved: 'pending', complete: false, items: [], nextCursor: 'resume-more', visibility: 'pending' },
  ]) {
    test(`${response.scope}/${response.resolved} does not invent an empty saved chapter state`, async () => {
      let afterMark = false;
      const saved = { structure, occurrence: occurrence(1), role: 'chapter', displayLabel: 'Chapter 1' };
      const client = { v1: {
        'reading-positions': () => ({ get: async () => ({ data: afterMark ? response
          : { scope: 'resume', resolved: saved.occurrence, complete: true, items: [saved] }, error: null }) }),
        compositions: () => ({ occurrences: () => ({ progress: {
          get: async () => ({ data: { completed: false, position: null, version: 0 }, error: null }),
          put: async () => { afterMark = true; return { data: { completed: true, position: 'read', version: 1 }, error: null }; },
        } }) }),
      } } as unknown as MainClient;
      const api = mainMediaApi(work, () => client);
      expect(await api.standing(work)).toMatchObject({ ok: true, data: { last: { occurrence: saved.occurrence } } });
      expect(await api.mark(saved, { completed: true })).toMatchObject({ ok: true });
      const read = await api.standing(work);
      expect(read).toMatchObject({ ok: true, data: { last: null, next: null } });
      if (!read.ok) throw new Error('unknown standing must remain visible');
      expect(chapterProgressWhere(read.data, copyOf('en'))).toBe('Unknown');
    });
  }

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
