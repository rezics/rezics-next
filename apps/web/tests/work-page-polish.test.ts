import { describe, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { messages as catalogue } from '../features/catalogue/messages.ts';
import { fills } from '../features/discover/fills.ts';
import { formatDate, languageName, mintedAt, sinceWhen, titleNeedsLanguageNote } from '../features/work-page/format.ts';
import { messages } from '../features/work-page/messages.ts';
import { bodyAfterTitle, chapterTitle } from '../features/work-page/reader.tsx';
import { linkedReview } from '../features/work-page/reviews.tsx';

const t = materializeData(messages.en, { locale: 'en' });

describe('Work page dates', () => {
  test('a UUIDv7 dates what it names; other IDs have no date', () => {
    const minted = mintedAt('https://rezics.com/id/01a0e430-e734-7752-8306-8a7206c148f4');
    expect(minted?.toISOString()).toBe('2026-09-27T18:46:45.300Z');
    expect(formatDate(minted!, 'en')).toBe('Sep 27, 2026');
    expect(formatDate(minted!, 'zh-Hans')).toBe('2026年9月27日');
    expect(mintedAt('https://rezics.com/id/5f7a2c1e-8d3b-4c6a-9e2f-1b4d6a8c0e3f')).toBeNull();
    expect(mintedAt('not an id')).toBeNull();
  });

  test('a serial’s last update reads as time ago within a month, then as a date', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    expect(sinceWhen('2026-09-28T11:30:00.000Z', 'en', now)).toBe('30 minutes ago');
    expect(sinceWhen('2026-09-25T12:00:00.000Z', 'en', now)).toBe('3 days ago');
    expect(sinceWhen('2026-09-27T09:00:00.000Z', 'zh-Hans', now)).toBe('昨天');
    expect(sinceWhen('2026-07-01T00:00:00.000Z', 'en', now)).toBe('Jul 1, 2026');
    expect(sinceWhen('garbage', 'en', now)).toBeNull();
  });
});

describe('title language note', () => {
  const title = (value: string, language: string, basis: 'requested' | 'fallback' = 'fallback') =>
    ({ value, language, basis });

  test('a title in the reader’s language, by tag or by script, needs no note', () => {
    expect(titleNeedsLanguageNote(title('Pride and Prejudice', 'en', 'requested'), 'zh-Hans')).toBe(false);
    expect(titleNeedsLanguageNote(title('雨夜书店', 'zh-Hans'), 'zh-Hant')).toBe(false);
    // An older record tags a Chinese title as English: to a Chinese reader it is Chinese.
    expect(titleNeedsLanguageNote(title('雨夜书店 · 连载小说', 'en'), 'zh-Hans')).toBe(false);
    expect(titleNeedsLanguageNote(title('西遊記', 'zh-Hant'), 'ja')).toBe(false);
  });

  test('a title whose record states no language is never said to be in another one, nor in "root"', () => {
    // Pride and Prejudice on the reseeded stack: Main tags its only title `und`.
    for (const locale of ['en', 'zh-Hans'] as const) {
      expect(titleNeedsLanguageNote(title('Pride and Prejudice', 'und'), locale)).toBe(false);
      expect(titleNeedsLanguageNote(title('Pride and Prejudice', 'mul'), locale)).toBe(false);
    }
    expect(languageName('und', 'en')).toBe('Unknown language');
    expect(languageName('und', 'zh-Hans')).toBe('未知语言');
    expect(languageName('und', 'ja')).toBe('Unknown language');
    expect(languageName('en', 'zh-Hans')).toBe('英语');
  });

  test('a title in another language is said to be one', () => {
    expect(titleNeedsLanguageNote(title('Pride and Prejudice', 'en'), 'zh-Hans')).toBe(true);
    expect(titleNeedsLanguageNote(title('雨夜书店', 'zh-Hans'), 'en')).toBe(true);
    expect(titleNeedsLanguageNote(title('Stolz und Vorurteil', 'de'), 'fr')).toBe(true);
    expect(titleNeedsLanguageNote(title('해와 달', 'ko'), 'ja')).toBe(true);
  });
});

describe('reader chapter titles', () => {
  test('a chapter without a title is named by its place, never "Untitled chapter"', () => {
    expect(chapterTitle({ value: 'Low Water' }, 1, t)).toBe('Low Water');
    expect(chapterTitle(null, 3, t)).toBe('Chapter 3');
    expect(chapterTitle({ value: '  ' }, 2, t)).toBe('Chapter 2');
  });

  test('a first line that only repeats the title is set once, as the heading', () => {
    expect(bodyAfterTitle(['第一章　雨夜', '雨停在书店打烊前。'], '第一章 雨夜')).toEqual(['雨停在书店打烊前。']);
    expect(bodyAfterTitle(['Chapter 1: Signals.', 'The radio woke.'], 'Chapter 1 — Signals')).toEqual(['The radio woke.']);
    expect(bodyAfterTitle(['The radio woke.', 'Again.'], 'Signals')).toEqual(['The radio woke.', 'Again.']);
    // A one-line chapter keeps its only line.
    expect(bodyAfterTitle(['Signals'], 'Signals')).toEqual(['Signals']);
  });
});

describe('reviews', () => {
  test('a feed link names one review by its ID', () => {
    expect(linkedReview('#review-9a8b7c6d-5e4f-4a3b-8c2d-000000000009')).toBe('9a8b7c6d-5e4f-4a3b-8c2d-000000000009');
    expect(linkedReview('#work-ratings')).toBeNull();
    expect(linkedReview('#review-not-an-id')).toBeNull();
  });
});

describe('catalogue strings', () => {
  test('cards read every locale’s translation, not English outside zh-Hans', () => {
    expect(catalogue.ja.wantToRead).toBe('読みたい');
    expect(catalogue['zh-Hant'].wantToRead).not.toBe(catalogue.en.wantToRead);
    expect(catalogue.de.wantToRead).not.toBe(catalogue.en.wantToRead);
  });
});

describe('Discover rows', () => {
  const loaded = (count: number) => ({ initial: { ok: true as const, data: { items: Array.from({ length: count }) } } });
  test('an overview row shows only when it loaded at least two Works', () => {
    expect(fills(loaded(2) as never)).toBe(true);
    expect(fills(loaded(1) as never)).toBe(false);
    expect(fills({ initial: { ok: false, failure: 'unbuilt' } } as never)).toBe(false);
  });
});
