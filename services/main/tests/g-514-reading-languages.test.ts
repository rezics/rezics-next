import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { contentLanguageVisible } from '../src/modules/feed/read.ts';
import { feedQuery } from '../src/modules/feed/contract.ts';
import { homePreferences } from '../src/modules/feed/personal.ts';
import { canonicalReadingLanguages, readingLanguages } from '../src/modules/preferences/languages.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { selectDisplayName } from '../src/modules/display-language/select.ts';

const languages = ['ar', 'zh-TW', 'yue-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'he', 'sr-Latn', 'pa-Arab'];

test('G-514: settings, Home and transient filters admit ordered languages beyond interface locales', () => {
  expect(canonicalReadingLanguages(languages)).toEqual(languages);
  expect(canonicalReadingLanguages(['AR', 'zh-tw', 'iw', 'he', 'yue-hant'])).toEqual(['ar', 'zh-TW', 'he', 'yue-Hant']);
  expect(Value.Check(readingLanguages, languages)).toBe(true);
  expect(Value.Check(homePreferences, { tab: 'all', sort: 'new', density: 'card', recommendations: true,
    contentLanguages: languages })).toBe(true);
  expect(Value.Check(feedQuery, { contentLanguages: languages })).toBe(true);
  expect(() => canonicalReadingLanguages(['en_US'])).toThrow();
  expect(() => canonicalReadingLanguages(Array(21).fill('en'))).toThrow();
});

test('G-514: saved reading languages preserve unknown posts and match regions without crossing scripts', () => {
  for (const tag of ['zh-Hant-TW', 'zh-TW']) {
    expect(contentLanguageVisible(tag, [undefined, ['zh-Hant']])).toBe(true);
    expect(contentLanguageVisible(tag, [['zh-Hant'], undefined])).toBe(true);
    expect(contentLanguageVisible(tag, [undefined, ['zh-Hans']])).toBe(false);
  }
  expect(contentLanguageVisible('sr-Cyrl-RS', [undefined, ['sr-Latn']])).toBe(false);
  expect(contentLanguageVisible(null, [undefined, ['ar']])).toBe(true);
  expect(contentLanguageVisible('', [undefined, ['ar']])).toBe(true);
  expect(contentLanguageVisible(null, [['ar'], ['ar']])).toBe(false);
  expect(contentLanguageVisible('ar-EG', [['ar'], ['ar']])).toBe(true);
});

test('G-514: signed-in display names use saved language order, with an explicit request override', () => {
  const request = new Request('http://main.test/v1/works', { headers: {
    'x-rezics-display-languages': 'de', 'accept-language': 'en' } });
  const session = new WorkReadSession({} as MainWorkDependencies, request, {}, { dataEpoch: 'epoch', sequence: '0' });
  expect(session.displayLanguages).toEqual(['de']);
  session.readingLanguages = ['ar', 'zh-TW', 'yue-Hant'];
  expect(session.displayLanguages).toEqual(['ar', 'zh-TW', 'yue-Hant', 'de', 'en']);
  expect(selectDisplayName({ original: 'en', labels: { en: 'English', 'zh-Hant': '漢字', ar: 'العربية' } },
    session.displayLanguages)).toMatchObject({ value: 'العربية', language: 'ar' });
  session.options.language = 'zh-Hant';
  expect(session.displayLanguages).toEqual(['zh-Hant', 'ar', 'zh-TW', 'yue-Hant', 'de', 'en']);
});

test('G-514 R1: Japanese reading preferences retain English UI and browser display fallbacks', () => {
  const labels = { original: 'zh-Hans', labels: { 'zh-Hans': '中文原名', en: 'English name' } };
  for (const headers of [new Headers({ 'x-rezics-display-languages': 'en,de', 'accept-language': 'fr' }),
    new Headers({ 'accept-language': 'en,de;q=0.8' })]) {
    const session = new WorkReadSession({} as MainWorkDependencies,
      new Request('http://main.test/v1/works', { headers }), {}, { dataEpoch: 'epoch', sequence: '0' });
    session.readingLanguages = ['ja'];
    expect(session.displayLanguages.slice(0, 3)).toEqual(['ja', 'en', 'de']);
    expect(selectDisplayName(labels, session.displayLanguages)).toMatchObject({ value: 'English name', language: 'en' });
  }
});

test('G-514: language consumers use the shared preference field and one feed membership rule', () => {
  const source = (name: string) => readFileSync(new URL(`../src/modules/${name}.ts`, import.meta.url), 'utf8');
  const personal = source('feed/personal');
  expect(personal).toContain('LEFT JOIN access.person_preferences p ON p.agent_id = reader.agent_id');
  expect(personal).toContain('LEFT JOIN (${PRIMARY_READING_PERSON_SQL}) reader ON true');
  expect(personal).not.toContain('writeReadingLanguages(client, input.actingSubject');
  expect(personal).toContain('contentLanguages: state?.content_languages ?? []');
  expect(personal).toContain("preferences: Omit<HomePreferences, 'contentLanguages'>");
  expect(personal).toContain('const { contentLanguages, ...preferences } = input.preferences');
  for (const file of ['feed/new-since', 'feed/trending']) {
    expect(source(file)).toContain('contentLanguageVisible(');
    expect(source(file)).not.toContain('language.toLowerCase() ===');
  }
  expect(source('onboarding/suggestions')).toContain('personal?.preferences.contentLanguages');
  expect(source('feed/read')).not.toContain("language: 'en', direction: 'ltr', basis: 'fallback'");
});
