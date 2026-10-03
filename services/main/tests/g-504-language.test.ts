import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { Value } from 'typebox/value';
import { canonicalLanguage, direction, languageSatisfies, parseLanguage, readerLanguages,
  selectDisplayName, validLocalizedText } from '../src/modules/display-language/select.ts';
import { languageTag } from '../src/modules/display-language/schema.ts';
import { readName } from '../src/modules/work/read-contract.ts';
import { resourceSummary } from '../src/modules/media/summary-contract.ts';
import { direction as mediaDirection, selectName } from '../src/modules/media/summary.ts';
import { recordedDisplayText, selectedMetadata } from '../src/modules/work/metadata-read.ts';
import { contentLanguages, InvalidContentLanguages, originalLanguages, recordedLanguageTag,
  textLanguage } from '../src/modules/release/languages.ts';

const languages = [
  ['az-Arab', 'az-Arab', 'Arab', 'rtl'], ['ar', 'ar', 'Arab', 'rtl'],
  ['he', 'he', 'Hebr', 'rtl'], ['ku-Arab', 'ku-Arab', 'Arab', 'rtl'],
  ['ku-Latn', 'ku-Latn', 'Latn', 'ltr'], ['ku', 'ku', 'Latn', 'ltr'],
  ['pa-Guru', 'pa-Guru', 'Guru', 'ltr'], ['pa-Arab', 'pa-Arab', 'Arab', 'rtl'],
  ['ug', 'ug', 'Arab', 'rtl'], ['zh-Hant-TW', 'zh-Hant-TW', 'Hant', 'ltr'],
  ['zh-TW', 'zh-TW', 'Hant', 'ltr'], ['sr-Latn', 'sr-Latn', 'Latn', 'ltr'],
  ['sr', 'sr', 'Cyrl', 'ltr'], ['ja', 'ja', 'Jpan', 'ltr'],
  ['AZ-aRaB', 'az-Arab', 'Arab', 'rtl'], ['EN-us', 'en-US', 'Latn', 'ltr'],
  ['X-Rezics-A', 'x-rezics-a', null, 'ltr'], ['EN-x-Rezics', 'en-x-rezics', 'Latn', 'ltr'],
  ['und', 'und', null, 'ltr'], ['zxx', 'zxx', null, 'ltr'], ['mul', 'mul', null, 'ltr'],
  ['und-Arab', 'und-Arab', 'Arab', 'rtl'], ['ff-Adlm', 'ff-Adlm', 'Adlm', 'rtl'],
  ['rhg-Rohg', 'rhg-Rohg', 'Rohg', 'rtl'], ['dv', 'dv', 'Thaa', 'rtl'],
  ['otk-Orkh', 'otk-Orkh', 'Orkh', 'rtl'],
] as const;

// RFC 5646 §2.1/§2.2.7 and ECMA-402 IsWellFormedLanguageTag have different private-only syntax.
// https://www.rfc-editor.org/rfc/rfc5646.html#section-2.2.7
// https://tc39.es/ecma402/#sec-iswellformedlanguagetag
test.each(languages)('G-504 parses %s, preserves source spelling and derives direction from script',
  (source, canonical, script, expectedDirection) => {
    expect(canonicalLanguage(source)).toBe(canonical);
    expect(parseLanguage(source)).toMatchObject({ originalTag: source, tag: canonical, script });
    expect(direction(source)).toBe(expectedDirection);
    expect(Value.Check(languageTag, source)).toBe(true);
  });

test.each(['', ' ', 'en_US', 'not a tag', 'e', 'en--US', 'en-x', 'x', 'x-123456789',
  'en-1234-1234', 'en-a-test-a-again', 'en-@', 'x-private\n'])('G-504 rejects malformed tag %j', source => {
  expect(canonicalLanguage(source)).toBeNull();
  expect(parseLanguage(source)).toBeNull();
  expect(Value.Check(languageTag, source)).toBe(false);
});

test.each([
  ['az-Arab', 'Latin text', 'rtl'], ['ku-Latn', 'کوردی', 'ltr'], ['ku', 'کوردی', 'ltr'],
  ['ar', 'Latin text', 'rtl'], ['pa-Guru', 'پنجابی', 'ltr'], ['und-Arab', 'Latin text', 'rtl'],
  ['und', '١٢٣ … العربية', 'rtl'], ['und', '123 … עברית', 'rtl'],
  ['und', '… 𞤀𞤁', 'rtl'], ['und', '… Latin العربية', 'ltr'], ['und', '… العربية Latin', 'rtl'],
  ['und', '… 𐰀', 'rtl'],
  ['und', '日本語 العربية', 'ltr'], ['und', '123 🎉', 'ltr'], ['und', '', 'ltr'],
  ['', '… العربية', 'rtl'],
] as const)('G-504 shared direction honors script and uses undetermined text letters', (language, text, expected) => {
  expect(direction(language, text)).toBe(expected);
  for (const requested of [[], [language]]) {
    expect(selectDisplayName(new Map([[language, text || '123']]), requested)?.direction).toBe(expected);
  }
});

test.each(['Script=Gara', 'Script='])('G-504 language entry imports when the engine rejects %s', async unsupported => {
  // A fresh process exercises module initialization without altering other tests' RegExp.
  const entry = new URL('../src/modules/display-language/select.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '-e', `
    const NativeRegExp = globalThis.RegExp;
    let rejected = 0;
    globalThis.RegExp = class extends NativeRegExp {
      constructor(pattern, flags) {
        if (typeof pattern === 'string' && pattern.includes(${JSON.stringify(unsupported)})) {
          rejected++;
          throw new SyntaxError('Simulated unsupported Unicode script');
        }
        super(pattern, flags);
      }
    };
    const { direction } = await import(${JSON.stringify(entry)});
    console.log(JSON.stringify({ rejected, directions: [direction('az-Arab'), direction('ku-Latn'),
      direction('und', 'العربية'), direction('und', 'Latin')] }));
  `], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  const result = JSON.parse(stdout);
  expect(result.rejected).toBeGreaterThan(0);
  expect(result.directions).toEqual(['rtl', 'ltr', unsupported === 'Script=' ? 'ltr' : 'rtl', 'ltr']);
});

test.each([
  ['az-Arab', 'آذری', 'rtl'], ['ku-Latn', 'Kurdî', 'ltr'], ['ku', 'Kurdî', 'ltr'],
  ['und', '١٢٣ … العربية', 'rtl'], ['und', 'Latin العربية', 'ltr'],
] as const)('G-504 media and Work metadata share direction for %s titles', (language, value, expected) => {
  expect(mediaDirection).toBe(direction);
  const name = { value, language, direction: expected };
  expect(selectName(new Map([[language, value]]), language)).toMatchObject(name);
  expect(recordedDisplayText({ language, value })).toEqual(name);
  const metadata = selectedMetadata({ localized: [{ language, title: value, description: value,
    tagline: value, mainVersionLabel: value }] }, language);
  for (const selected of Object.values(metadata)) expect(selected).toMatchObject(name);
});

test('G-504 an undetermined RTL label keeps its language on exact and original fallback paths', () => {
  const field = { original: 'und', labels: { en: 'English', und: '١٢٣ … العربية' } };
  expect(selectDisplayName(field, ['und'])).toEqual({ value: '١٢٣ … العربية', language: 'und',
    direction: 'rtl', basis: 'requested' });
  expect(selectDisplayName(field, ['ja'])).toEqual({ value: '١٢٣ … العربية', language: 'und',
    direction: 'rtl', basis: 'fallback' });
});

test('G-504 languageTag runs the shared validator in an API request', async () => {
  const app = new Elysia().post('/language', { body: languageTag }, ({ body }) => parseLanguage(body));
  const request = (value: string) => new Request('http://localhost/language', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const valid = await app.handle(request('X-Rezics'));
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({ originalTag: 'X-Rezics', tag: 'x-rezics' });
  expect((await app.handle(request('en--US'))).status).toBe(422);
});

test.each([
  [{ original: 'ja', labels: { ja: '原題', 'zh-Hant': '繁體', 'zh-Hans': '简体' } }, ['zh-Hant'],
    { value: '繁體', language: 'zh-Hant', direction: 'ltr', basis: 'requested' }],
  [{ original: 'ja', labels: { ja: '原題', 'zh-Hant': '繁體', 'zh-Hans': '简体' } }, ['zh-TW'],
    { value: '繁體', language: 'zh-Hant', direction: 'ltr', basis: 'same-script' }],
  [{ original: 'ja', labels: { ja: '原題', 'zh-Hans': '简体' } }, ['zh-Hant'],
    { value: '简体', language: 'zh-Hans', direction: 'ltr', basis: 'other-script' }],
  [{ original: 'sr', labels: { sr: 'Ћирилица' } }, ['sr-Latn'],
    { value: 'Ћирилица', language: 'sr', direction: 'ltr', basis: 'other-script' }],
  [{ original: 'ku-Arab', labels: { 'ku-Arab': 'کوردی' } }, ['ku-Latn'],
    { value: 'کوردی', language: 'ku-Arab', direction: 'rtl', basis: 'other-script' }],
  [{ original: 'ja', labels: { en: 'English', ja: '原題' } }, ['de'],
    { value: '原題', language: 'ja', direction: 'ltr', basis: 'fallback' }],
  [{ original: 'und', labels: { en: 'English', und: 'Unknown source language' } }, ['de'],
    { value: 'Unknown source language', language: 'und', direction: 'ltr', basis: 'fallback' }],
] as const)('G-504 selects an actual language, direction and explicit basis', (field, readers, expected) => {
  const selected = selectDisplayName(field, readers);
  expect(selected).toEqual(expected);
  expect(Value.Check(readName, selected)).toBe(true);
  expect(Value.Check(resourceSummary, { reference: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    status: 'available', type: 'resource', base: 'resource', work: null, disclosure: 'public', name: selected,
    address: { prefix: '/e/',key: 'resource',suffixSource: selected?.value ?? '' },
    avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'test', resourceType: 'resource' } })).toBe(true);
});

test('G-504 reader order cannot let an other-script fallback hide a later readable choice', () => {
  const field = { original: 'zh-Hans', labels: { 'zh-Hans': '简体', ja: '日本語' } };
  expect(selectDisplayName(field, ['zh-Hant', 'ja'])?.basis).toBe('requested');
  expect(selectDisplayName(field, ['zh-Hant', 'ja'])?.language).toBe('ja');
  expect(selectDisplayName(new Map([['ja', 'Original'], ['en', 'English']]), ['de'])?.language).toBe('ja');
  expect(selectDisplayName(new Map())).toBeNull();
});

test('G-504 source casing survives selection and unrecorded language stays unrecorded', () => {
  const source = { original: 'AZ-aRaB', labels: { en: 'English', 'AZ-aRaB': 'آذری' } };
  const before = JSON.stringify(source);
  expect(selectDisplayName(source, ['az-Arab'])).toEqual({ value: 'آذری', language: 'az-Arab',
    direction: 'rtl', basis: 'requested' });
  expect(selectDisplayName(source, ['de'])?.language).toBe('az-Arab');
  expect(JSON.stringify(source)).toBe(before);
  expect(selectDisplayName(new Map([['', 'Unrecorded'], ['en', 'English']]), ['en-US']))
    .toMatchObject({ language: 'en', basis: 'same-script' });
  expect(selectDisplayName(new Map([['', 'Unrecorded']]), ['en']))
    .toEqual({ value: 'Unrecorded', language: '', direction: 'ltr', basis: 'fallback' });
});

test('G-504 25 stored labels round trip within a UTF-8 budget without a cardinality limit', () => {
  const field = { original: 'en', labels: { en: 'Original', ...Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`en-x-label${index}`, `Label ${index}`])) } };
  const restored = JSON.parse(JSON.stringify(field));
  expect(Object.keys(restored.labels)).toHaveLength(25);
  expect(validLocalizedText(restored, 200)).toBe(true);
  expect(restored).toEqual(field);
  expect(selectDisplayName(restored, ['en-x-label23']))
    .toMatchObject({ value: 'Label 23', language: 'en-x-label23', basis: 'requested' });
  const multibyte = { original: 'ja', labels: { ja: '猫猫' } };
  const bytes = new TextEncoder().encode(JSON.stringify(multibyte)).byteLength;
  expect(validLocalizedText(multibyte, 2, bytes)).toBe(true);
  expect(validLocalizedText(multibyte, 2, bytes - 1)).toBe(false);
  expect(validLocalizedText({ original: 'en', labels: { en: 'A'.repeat(70_000) } }, 70_000)).toBe(false);
  expect(validLocalizedText({ original: 'mul', labels: { mul: 'Two languages' } }, 200)).toBe(false);
});

test.each([
  ['zh-Hans', ['zh-Hant'], false], ['zh-TW', ['zh-Hant'], true], ['zh-Hant', ['zh-TW'], true],
  ['sr', ['sr-Latn'], false], ['sr-Latn', ['sr-Cyrl'], false], ['sr-RS', ['sr'], true],
  ['ku-Arab', ['ku-Latn'], false], ['AZ-aRaB', ['az-Arab'], true],
  ['en-x-rezics', ['en-US'], true], ['X-Rezics', ['x-rezics'], true], ['x-rezics', ['x-other'], false],
  ['und', ['en'], false], ['und', ['und'], true], ['zxx', ['en'], false], ['zxx', ['zxx'], true],
  ['mul', ['en', 'ja'], false], ['', ['und'], false], [null, ['en'], false],
  ['qaa-US', ['qaa'], false], ['qaa-US', ['qaa-US'], true],
  ['bad tag', ['en'], false], ['en', [], false], ['en', ['de', 'en-US'], true],
] as const)('G-504 reader language membership uses the same script-aware match', (content, readers, expected) => {
  expect(languageSatisfies(content, readers)).toBe(expected);
  if (content && canonicalLanguage(content)) {
    const selected = selectDisplayName(new Map([[content, 'Text']]), readers);
    expect(selected?.basis === 'requested' || selected?.basis === 'same-script').toBe(expected);
  }
});

test('G-504 release language lists keep absent, undetermined, nonlinguistic and multiple distinct', () => {
  expect(contentLanguages([])).toEqual([]);
  expect(contentLanguages(['zxx'])).toEqual(['zxx']);
  expect(contentLanguages(['X-Rezics', 'AZ-aRaB'])).toEqual(['az-Arab', 'x-rezics']);
  expect(originalLanguages(['und'], true)).toEqual(['und']);
  expect(textLanguage('')).toBeNull();
  expect(textLanguage(null)).toBeNull();
  for (const values of [['mul'], ['und'], ['zxx', 'en'], ['en', 'EN']]) {
    expect(() => contentLanguages(values)).toThrow(InvalidContentLanguages);
  }
  expect(() => recordedLanguageTag('')).toThrow(InvalidContentLanguages);
  expect(readerLanguages('AZ-aRaB,x-Rezics,az-Arab,und,zxx,mul,not a tag'))
    .toEqual(['az-Arab', 'x-rezics', 'und', 'zxx', 'mul']);
});
