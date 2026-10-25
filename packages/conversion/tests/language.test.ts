import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalLanguageTag,
  inLanguageTag,
  labelLanguageTag,
  marcLanguageTag,
  platformLabelLanguages,
} from '../src/support.ts';

test('canonical language tags follow BCP 47 canonical form and refuse ill-formed tags', () => {
  const cases: [string, string | null][] = [
    ['pt-br', 'pt-BR'],
    ['eng', 'en'],
    ['jpn', 'ja'],
    ['zh-hans', 'zh-Hans'],
    ['ja-latn', 'ja-Latn'],
    ['EN-gb', 'en-GB'],
    ['es-419', 'es-419'],
    ['be-tarask', 'be-tarask'],
    ['iw', 'he'],
    ['zh-min-nan', null],
    ['en_US', null],
    ['', null],
    ['a', null],
    ['x'.repeat(65), null],
  ];
  for (const [input, expected] of cases) expect([input, canonicalLanguageTag(input)]).toEqual([input, expected]);
});

test('inLanguage tags admit only canonical language, script and region', () => {
  const cases: [string, string | null][] = [
    ['pt-br', 'pt-BR'],
    ['eng', 'en'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['es-419', 'es-419'],
    ['mul', 'mul'],
    ['zxx', 'zxx'],
    ['und', null],
    ['be-tarask', null],
    ['en-x-private', null],
    ['simple', null],
    ['zh-min-nan', null],
  ];
  const pattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
  for (const [input, expected] of cases) {
    const actual = inLanguageTag(input);
    expect([input, actual]).toEqual([input, expected]);
    if (actual !== null) expect(actual).toMatch(pattern);
  }
});

test('MARC language codes map bibliographic and discontinued codes before canonicalizing', () => {
  const cases: [string, string | null][] = [
    ['eng', 'en'],
    ['jpn', 'ja'],
    ['fre', 'fr'],
    ['ger', 'de'],
    ['chi', 'zh'],
    ['dut', 'nl'],
    ['gre', 'el'],
    ['per', 'fa'],
    ['wel', 'cy'],
    ['tib', 'bo'],
    ['cze', 'cs'],
    ['slo', 'sk'],
    ['rum', 'ro'],
    ['mac', 'mk'],
    ['mao', 'mi'],
    ['may', 'ms'],
    ['alb', 'sq'],
    ['arm', 'hy'],
    ['baq', 'eu'],
    ['bur', 'my'],
    ['geo', 'ka'],
    ['ice', 'is'],
    ['scc', 'sr'],
    ['scr', 'hr'],
    ['far', 'fo'],
    ['fri', 'fy'],
    ['iri', 'ga'],
    ['tag', 'tl'],
    ['mul', 'mul'],
    ['und', null],
    ['ENG', null],
    ['en', null],
    ['zzzz', null],
  ];
  for (const [input, expected] of cases) expect([input, marcLanguageTag(input)]).toEqual([input, expected]);
});

test('platform label languages are exactly the shipped presentation locales', () => {
  const directory = resolve(import.meta.dir, '../../definitions/presentation/core');
  const shipped = readdirSync(directory)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .sort();
  expect([...platformLabelLanguages].sort()).toEqual(shipped);
  expect(Object.isFrozen(platformLabelLanguages)).toBe(true);
});

test('label language tags keep platform languages and the multilingual default only', () => {
  const cases: [string, string | null][] = [
    ['en', 'en'],
    ['en-gb', 'en-GB'],
    ['de-ch', 'de-CH'],
    ['zh', 'zh'],
    ['zh-hans', 'zh-Hans'],
    ['zh-tw', 'zh-TW'],
    ['ja-latn', 'ja-Latn'],
    ['ko', 'ko'],
    ['mul', 'mul'],
    ['th', null],
    ['yue', null],
    ['be-tarask', null],
    ['zh-min-nan', null],
    ['simple', null],
  ];
  for (const [input, expected] of cases) expect([input, labelLanguageTag(input)]).toEqual([input, expected]);
});
