import { describe, expect, test } from 'bun:test';
import { chapterPosition, flattenChapters, gameStatus, mediumOf, resumeAt, type ChapterRef } from '../features/tracking/media.ts';

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

  test('a game is completed from its required parts, and a route alone leaves it played', () => {
    const story = { required: true, completed: true, started: true };
    const route = { required: false, completed: false, started: false };
    expect(gameStatus([story, route])).toBe('completed');
    expect(gameStatus([{ ...story, completed: false }, { ...route, completed: true, started: true }])).toBe('played');
    expect(gameStatus([])).toBe('none');
  });
});
