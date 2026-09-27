import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { excludedFeedSource } from '../src/modules/feed/read.ts';
import type { FeedSource } from '../src/modules/feed/source.ts';
import { defaultPreferences, homePreferences, watermarkCommand } from '../src/modules/feed/personal.ts';
import { parseChoices } from '../src/modules/onboarding-interests/read.ts';
import { continueResult } from '../src/modules/continue/contract.ts';

const id = (n: number) => `https://rezics.com/id/${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
const source = (n: number): FeedSource => ({ id: id(n), kind: 'work', actor: id(500),
  realm: id(501), work: id(502) } as FeedSource);

test('G302: hide and mute remove all matching cards; fewer retains a stable minority', () => {
  const all = Array.from({ length: 256 }, (_, index) => source(index));
  for (const rule of [
    { kind: 'realm' as const, target: id(501), strength: 'mute' as const },
    { kind: 'person' as const, target: id(500), strength: 'mute' as const },
    { kind: 'work' as const, target: id(502), strength: 'hide' as const },
    { kind: 'work' as const, target: id(502), strength: 'not-interested' as const },
  ]) expect(all.every(item => excludedFeedSource(item, [rule]))).toBe(true);
  const fewer = { kind: 'kind' as const, target: 'work', strength: 'fewer' as const };
  const retained = all.filter(item => !excludedFeedSource(item, [fewer]));
  expect(retained.length).toBeGreaterThan(40);
  expect(retained.length).toBeLessThan(90);
  expect(retained.map(item => item.id)).toEqual(all.filter(item => !excludedFeedSource(item, [fewer]))
    .map(item => item.id));
  expect(excludedFeedSource(source(0), [{ kind: 'realm', target: id(999), strength: 'mute' }])).toBe(false);
  expect(excludedFeedSource(source(0), [{ kind: 'continue', target: id(502), strength: 'hide' }])).toBe(false);
});

test('G302: home preferences and watermark contracts reject ambiguous state', () => {
  expect(Value.Check(homePreferences, defaultPreferences)).toBe(true);
  expect(Value.Check(homePreferences, { ...defaultPreferences, contentLanguages: ['en', 'en'] })).toBe(false);
  expect(Value.Check(watermarkCommand, { actingSubject: id(1), scope: 'realm:other',
    dataEpoch: 'epoch', sequence: '3' })).toBe(false);
  expect(Value.Check(watermarkCommand, { actingSubject: id(1), scope: `realm:${id(2)}`,
    dataEpoch: 'epoch', sequence: '3' })).toBe(true);
  expect(Value.Check(continueResult, { profile: 'home-continue-v1', items: [],
    sourcePosition: { dataEpoch: 'epoch', sequence: '3' }, scanned: { reading: 0, followed: 0, limit: 16 } })).toBe(true);
});

test('G302: onboarding choices preserve membership and reject duplicates or unknown kinds', () => {
  expect(parseChoices('books,recipes', ['books', 'recipes'], 2)).toEqual(['books', 'recipes']);
  expect(() => parseChoices('books,books', ['books'], 2)).toThrow();
  expect(() => parseChoices('books,other', ['books'], 2)).toThrow();
  expect(() => parseChoices('books,recipes', ['books', 'recipes'], 1)).toThrow();
});
