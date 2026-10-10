import { describe, expect, test } from 'bun:test';
import { progressControl } from '../features/tracking/medium-progress.tsx';
import { workProgressConflict } from '../features/tracking/media-api.ts';
import { chapterPosition, flattenChapters, gameStatus, mediumOf, resumeAt, resumeName, type ChapterRef } from '../features/tracking/media.ts';

const chapter = (volume: number, number: number, id = `${volume}-${number}`): ChapterRef => ({
  volume: { number: volume, label: String(volume) },
  number, occurrence: `https://example.test/occ/${id}`, structure: 'https://example.test/book', label: null,
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
