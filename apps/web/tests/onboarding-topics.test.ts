import { describe, expect, test } from 'bun:test';
import { broaderName, MAX_TOPICS, startingLanguages, toggled, topicGroups } from '../features/onboarding/topics.ts';
import { choices } from '../features/onboarding/welcome-fixtures.ts';

describe('G-431 the setup\'s topics', () => {
  test('types that read the same share one group, and a topic shows once in it', () => {
    const groups = topicGroups(choices.groups);
    expect(groups.map(group => group.heading)).toEqual(['typeBooks', 'typeGames', 'typeRecipes']);
    const books = groups[0]!;
    expect(books.cover).toBe('book');
    expect(new Set(books.topics.map(topic => topic.id)).size).toBe(books.topics.length);
    expect(topicGroups([{ type: 'https://example.com/Unknown', concepts: [] }])[0]?.heading).toBe('typeGuides');
  });

  test('a narrower topic names its broader one when it is offered too', () => {
    const groups = topicGroups(choices.groups);
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

  test('languages start from the reader\'s settings, else the page\'s locale', () => {
    const offered = ['zh-Hans', 'en', 'ja'];
    expect(startingLanguages(['ja', 'tlh'], offered, 'zh-Hans')).toEqual(['ja']);
    expect(startingLanguages([], offered, 'zh-Hans')).toEqual(['zh-Hans']);
    expect(startingLanguages(null, offered, 'fr')).toEqual(['zh-Hans']);
  });
});
