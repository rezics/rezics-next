import { describe, expect, test } from 'bun:test';
import { communityPeople } from './community-plan.ts';
import { extraWorks, fictionWorks, penNames } from './official-plan.ts';
import { people, works } from './plan.ts';
import { ratingPlan } from './ratings.ts';
import { coReaderWorks, readingLives } from './reading-lives-plan.ts';
import { reviews } from './reviews-plan.ts';

const everyone = new Set([...people, ...communityPeople].map(person => person.id));
const known = new Set([...works.map(work => work.id), ...fictionWorks.map(work => work.id),
  ...extraWorks.map(work => work.id)]);
/** Who a Work is credited to, with pen names resolved to the person who writes under them. */
function authorOf(id: string): string | null {
  const author = works.find(work => work.id === id)?.author ?? fictionWorks.find(work => work.id === id)?.author
    ?? extraWorks.find(work => work.id === id)?.owner ?? null;
  return author === 'moonlight' ? 'mei' : penNames.find(pen => pen.id === author)?.owner ?? author;
}
const today = '2026-09-28';

describe('Reviews', () => {
  test('twenty to forty, one per reader and Work, long and short', () => {
    expect(reviews.length).toBeGreaterThanOrEqual(20);
    expect(reviews.length).toBeLessThanOrEqual(40);
    expect(new Set(reviews.map(review => `${review.reader}:${review.work}`)).size).toBe(reviews.length);
    for (const review of reviews) {
      expect(everyone.has(review.reader)).toBe(true);
      expect(known.has(review.work)).toBe(true);
      expect(review.text.length).toBeLessThanOrEqual(8000);
      expect(authorOf(review.work)).not.toBe(review.reader);
      for (const voter of review.helpful ?? []) {
        expect(everyone.has(voter)).toBe(true);
        expect(voter).not.toBe(review.reader);
      }
      expect(new Set(review.helpful ?? []).size).toBe((review.helpful ?? []).length);
    }
    expect(reviews.some(review => review.text.length > 300)).toBe(true);
    expect(reviews.some(review => review.text.length < 80)).toBe(true);
    expect(reviews.some(review => review.spoiler)).toBe(true);
    expect(new Set(reviews.map(review => review.language))).toEqual(new Set(['en', 'zh-Hans', 'ja']));
    // Classics, the serial, mods and prompts all have reviews.
    for (const id of ['pride', 'serial', 'lumen-fabric', 'club-prompt-v1']) {
      expect(reviews.some(review => review.work === id)).toBe(true);
    }
  });

  test('each stands on its reader’s rating, and ratings spread so histograms have shape', () => {
    const plan = ratingPlan();
    for (const review of reviews) expect(plan.get(review.reader)?.get(review.work)).toBe(review.rating);
    for (const life of readingLives) {
      for (const [work, value] of Object.entries(life.ratings)) {
        const reviewed = reviews.find(review => review.reader === life.person && review.work === work);
        if (reviewed) expect(value).toBe(reviewed.rating);
      }
    }
    for (const [person, rated] of plan) {
      for (const [work, value] of rated) {
        expect(known.has(work)).toBe(true);
        if (authorOf(work) === person) expect(value).toBeNull();
      }
    }
    for (const id of ['pride', 'serial', 'lumen-fabric']) {
      const values = [...plan.values()].flatMap(rated => rated.get(id) ?? []);
      expect(new Set(values).size).toBeGreaterThanOrEqual(2);
      expect(values.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('Reading lives', () => {
  test('at least eight public libraries with dated shelves', () => {
    expect(readingLives.length).toBeGreaterThanOrEqual(8);
    expect(new Set(readingLives.map(life => life.person)).size).toBe(readingLives.length);
    for (const life of readingLives) {
      expect(everyone.has(life.person)).toBe(true);
      expect(new Set(life.shelf.map(entry => entry.work)).size).toBe(life.shelf.length);
      expect(new Set(life.shelf.map(entry => entry.status)).size).toBeGreaterThanOrEqual(2);
      for (const entry of life.shelf) {
        expect(known.has(entry.work)).toBe(true);
        if (entry.status === 'want-to-read') expect([entry.startedOn, entry.finishedOn]).toEqual([null, null]);
        // Main records dates for finished reads only.
        if (entry.status === 'reading') expect([entry.startedOn, entry.finishedOn]).toEqual([null, null]);
        if (entry.status === 'read') expect(entry.startedOn! <= entry.finishedOn! && entry.finishedOn! <= today).toBe(true);
      }
    }
    expect(readingLives.filter(life => life.shelf.some(entry => entry.work === 'serial')).length).toBeGreaterThanOrEqual(4);
  });

  test('overlap enough for co-readers on Pride and Prejudice, 雨夜书店 and a mod', () => {
    const plan = ratingPlan();
    // Main counts a public reader of a source Work when they are reading or have read it, or rated it 4+,
    // and a candidate when they have read it or rated it 4+; it drops candidates by the source's author.
    const source = (person: string, work: string) => readingLives.find(life => life.person === person)!.shelf
      .some(entry => entry.work === work && entry.status !== 'want-to-read') || (plan.get(person)?.get(work) ?? 0) >= 4;
    const candidate = (person: string, work: string) => readingLives.find(life => life.person === person)!.shelf
      .some(entry => entry.work === work && entry.status === 'read') || (plan.get(person)?.get(work) ?? 0) >= 4;
    for (const id of coReaderWorks) {
      const readers = readingLives.map(life => life.person).filter(person => source(person, id));
      expect(readers.length).toBeGreaterThanOrEqual(4);
      const candidates = [...known].filter(work => work !== id && authorOf(work) !== authorOf(id)
        && readers.some(person => candidate(person, work)));
      expect(candidates.length).toBeGreaterThan(0);
    }
  });
});
