import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { currentProfile, publicProfile, RealmProfileInvalid } from '../src/modules/realm-profile/schema.ts';
import { readerLanguages, selectDisplayName } from '../src/modules/display-language/select.ts';
import { checkedAgentProfile, AgentProfileInvalid } from '../src/modules/agent/profile.ts';

const name = { original: 'en', labels: { en: 'Fiction', 'zh-Hans': '小说',
  'zh-Hant': '小說', ja: 'フィクション' } };

test('display language uses requested order, exact tags, script, primary language, then original', () => {
  expect(readerLanguages('de,zh-TW,en', 'ja;q=1')).toEqual(['de', 'zh-TW', 'en']);
  expect(readerLanguages(null, 'de;q=0.5,ja;q=1,zh-TW;q=0')).toEqual(['ja', 'de']);
  expect(selectDisplayName(name, ['zh-Hant'])?.value).toBe('小說');
  expect(selectDisplayName(name, ['zh-TW'])?.value).toBe('小說');
  expect(selectDisplayName(name, ['zh-CN'])?.value).toBe('小说');
  expect(selectDisplayName(name, ['zh-HK'])?.value).toBe('小說');
  expect(selectDisplayName(name, ['de', 'ja'])?.value).toBe('フィクション');
  expect(selectDisplayName(name, ['de'])).toEqual({ value: 'Fiction', language: 'en',
    direction: 'ltr', basis: 'fallback' });
  expect(selectDisplayName({ original: 'ar', labels: { ar: 'رواية', en: 'Novel' } }, ['ar'])?.direction)
    .toBe('rtl');
});

test('only a bounded localized organization name can accompany an Agent profile write', () => {
  const input = { agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    expectedHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    displayName: 'North Star Editions', avatarSelection: null, bio: null, idempotencyKey: 'org-v2',
    localizedName: { original: 'en', labels: { en: 'North Star Editions', 'zh-Hans': '北辰出版' } } };
  expect(checkedAgentProfile(input).localizedName?.labels['zh-Hans']).toBe('北辰出版');
  expect(() => checkedAgentProfile({ ...input, displayName: 'North Star Editions · 北辰出版' }))
    .toThrow(AgentProfileInvalid);
});

test('localized fields fall back independently and legacy revisions normalize without changing identity', () => {
  const description = { original: 'en', labels: { en: 'Stories and novels' } };
  expect(selectDisplayName(name, ['ja'])?.value).toBe('フィクション');
  expect(selectDisplayName(description, ['ja'])?.basis).toBe('fallback');
  const legacy = { name: { en: 'Fiction', 'zh-CN': '小说' },
    description: { en: 'Stories', 'zh-CN': '故事' }, iconSelection: null,
    bannerSelection: null, count: { kind: 'unknown', value: null }, moderators: [],
    rules: [{ id: 'kind', title: { en: 'Be kind', 'zh-CN': '友善' },
      body: { en: 'Respect readers', 'zh-CN': '尊重读者' }, governanceRule: null }] };
  const migrated = currentProfile(legacy);
  expect(migrated.name).toEqual({ original: 'en', labels: { en: 'Fiction', 'zh-Hans': '小说' } });
  expect(migrated.rules[0]?.title.labels['zh-Hans']).toBe('友善');
  expect(Value.Check(publicProfile, migrated)).toBe(true);
  expect(() => currentProfile({ ...migrated, name: { original: 'de', labels: { en: 'Fiction' } } }))
    .toThrow(RealmProfileInvalid);
  expect(() => currentProfile({ ...migrated, name: { original: 'en', labels: Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`en-${index}`, 'A'])) } }))
    .toThrow(RealmProfileInvalid);
});
