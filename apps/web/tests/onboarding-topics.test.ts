import { beforeAll, describe, expect, test } from 'bun:test';
import { added, earlier, languageTag, matchingLanguages, MAX_LANGUAGES } from '../features/onboarding/languages.ts';
import { broaderName, MAX_TOPICS, startingLanguages, toggled, topicGroups } from '../features/onboarding/topics.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

import { choices } from '../features/onboarding/welcome-fixtures.ts';

beforeAll(seedServedTypes);

describe('G-431 the setup\'s topics', () => {
  test('types that read the same share one group, and a topic shows once in it', () => {
    seedServedTypes();
    const groups = topicGroups(choices.groups, 'en');
    expect(groups.map(group => group.heading)).toEqual(['Books', 'Games', 'Recipes']);
    expect(groups.map(group => group.cover)).toEqual(['book', 'game', 'recipe']);
    expect(topicGroups(choices.groups, 'ja').map(group => group.heading)).toEqual(['本', 'ゲーム', 'レシピ']);
    const books = groups[0]!;
    expect(books.cover).toBe('book');
    expect(new Set(books.topics.map(topic => topic.id)).size).toBe(books.topics.length);
    // A type the registry does not know gets its base's default heading and cover.
    expect(topicGroups([{ type: 'https://example.com/Unknown', concepts: [] }], 'en')[0])
      .toMatchObject({ heading: 'Works', cover: 'document' });
  });

  test('a narrower topic names its broader one when it is offered too', () => {
    seedServedTypes();
    const groups = topicGroups(choices.groups, 'en');
    const xianxia = groups[0]!.topics.find(topic => topic.name.value === '仙侠')!;
    expect(broaderName(groups, xianxia)).toBe('Fantasy');
    expect(broaderName(groups, groups[0]!.topics[0]!)).toBeNull();
  });

  test('eight topics fill Home\'s tabs; a ninth is refused rather than dropping another', () => {
    const eight = Array.from({ length: MAX_TOPICS }, (_, index) => `t${index}`);
    expect(toggled(eight, 'extra')).toEqual(eight);
    expect(toggled(eight, 't3')).toEqual(eight.filter(item => item !== 't3'));
    expect(toggled([], 'a')).toEqual(['a']);
  });

  test('languages start from the reader\'s settings in their order, else the page\'s locale', () => {
    const offered = ['zh-Hans', 'en', 'ja'];
    expect(startingLanguages(['yue', 'ja'], offered, 'zh-Hans')).toEqual(['yue', 'ja']);
    expect(startingLanguages([], offered, 'zh-Hans')).toEqual(['zh-Hans']);
    expect(startingLanguages(null, offered, 'fr')).toEqual(['zh-Hans']);
  });
});

describe('G-431 the setup\'s languages', () => {
  test('any BCP 47 language joins in canonical form; a malformed one does not', () => {
    expect(languageTag('zh-hans')).toBe('zh-Hans');
    expect(languageTag(' pt-br ')).toBe('pt-BR');
    expect(languageTag('yue')).toBe('yue');
    expect(languageTag('not a tag')).toBeNull();
    expect(languageTag('')).toBeNull();
  });

  test('the list keeps its order: added last, moved one place up, never repeated or past the bound', () => {
    expect(added(['en'], 'ja')).toEqual(['en', 'ja']);
    expect(added(['en', 'ja'], 'en')).toEqual(['en', 'ja']);
    const eight = Array.from({ length: MAX_LANGUAGES }, (_, index) => `x${index}`);
    expect(added(eight, 'ja')).toEqual(eight);
    expect(earlier(['en', 'ja', 'ko'], 'ko')).toEqual(['en', 'ko', 'ja']);
    expect(earlier(['en', 'ja'], 'en')).toEqual(['en', 'ja']);
  });

  test('a language is found by its name here, its own name or its code; a typed tag is offered too', () => {
    expect(matchingLanguages('brazil', 'en', [])).toEqual(['pt-BR']);
    expect(matchingLanguages('日本', 'en', [])).toEqual(['ja']);
    expect(matchingLanguages('葡萄牙', 'zh-Hans', [])).toContain('pt');
    expect(matchingLanguages('gsw', 'en', [])).toEqual(['gsw']);
    expect(matchingLanguages('japanese', 'en', ['ja'])).toEqual([]);
    expect(matchingLanguages('', 'en', [])).toEqual([]);
  });
});
