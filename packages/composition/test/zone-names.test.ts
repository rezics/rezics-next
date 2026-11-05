import { expect, test } from 'bun:test';
import {
  UI_LOCALES,
  pickZoneName,
  platformRegistry,
  validateZoneConfiguration,
  validateZoneStarter,
  type ZoneConfiguration,
} from '../src/index.ts';

const configuration = (): ZoneConfiguration => ({
  primaryLanguage: 'ja',
  labels: { ja: '私の本棚' },
  pages: [{ route: '', document: { root: { props: {} }, content: [] } }],
  scope: [],
});
const validate = (value: unknown) => validateZoneConfiguration(platformRegistry, value, { filters: new Set() });

test('saved Zones accept each supported primary name without requiring translations or changing starter rules', () => {
  for (const language of UI_LOCALES) {
    const value = { ...configuration(), primaryLanguage: language, labels: { [language]: 'My site' } };
    expect(validate(value)).toEqual([]);
    expect(pickZoneName(value, 'it')).toEqual({ text: 'My site', lang: language });
    expect(validateZoneStarter(platformRegistry, value, { filters: new Set() }).length).toBeGreaterThan(0);
  }
  const legacy = { ...configuration(), labels: Object.fromEntries(UI_LOCALES.map((language) => [language, language])) };
  delete legacy.primaryLanguage;
  expect(validate(legacy)).toEqual([]);
  expect(validateZoneStarter(platformRegistry, legacy, { filters: new Set() })).toEqual([]);
  delete legacy.labels.en;
  expect(validate(legacy)).toContainEqual({ pointer: '/labels/en', code: 'invalid' });
});

test('optional translations must be authored valid names and the explicit primary must be present', () => {
  expect(validate({ ...configuration(), labels: { ja: '本棚', de: 'Bücher' } })).toEqual([]);
  expect(validate({ ...configuration(), labels: { ja: '📚'.repeat(80) } })).toEqual([]);
  for (const labels of [{}, { de: 'Bücher' }, { ja: '  ' }, { ja: '📚'.repeat(81) }, { ja: '<b>本棚</b>' }]) {
    expect(validate({ ...configuration(), labels }).some((error) => error.pointer === '/labels/ja')).toBe(true);
  }
  for (const value of ['', '  ', '<script>', '\u0000', 'x'.repeat(81), null]) {
    expect(
      validate({ ...configuration(), labels: { ja: '本棚', de: value } }).some(
        (error) => error.pointer === '/labels/de',
      ),
    ).toBe(true);
  }
  expect(validate({ ...configuration(), primaryLanguage: 'it' })).toContainEqual({
    pointer: '/primaryLanguage',
    code: 'invalid',
  });
  expect(validate({ ...configuration(), labels: { ja: '本棚', it: 'Libri' } })).toContainEqual({
    pointer: '/labels/it',
    code: 'invalid',
  });
  expect(validate({ ...configuration(), translated: true })).toContainEqual({
    pointer: '/translated',
    code: 'invalid',
  });
});

test('name fallback is deterministic over disclosed labels without inventing a translation', () => {
  const value = { primaryLanguage: 'ja' as const, labels: { ja: '本棚', de: 'Bücher' } };
  const before = structuredClone(value);
  expect(pickZoneName(value, 'de')).toEqual({ text: 'Bücher', lang: 'de' });
  expect(pickZoneName(value, 'fr')).toEqual({ text: '本棚', lang: 'ja' });
  expect(value).toEqual(before);
  expect(pickZoneName({ primaryLanguage: 'ja', labels: { de: 'Bücher' } }, 'fr')).toEqual({ text: '' });
  expect(pickZoneName({ labels: { es: 'Libros', ja: '本棚' } }, 'fr')).toEqual({ text: '本棚', lang: 'ja' });
  expect(pickZoneName({ labels: { ja: '本棚', es: 'Libros' } }, 'fr')).toEqual({ text: '本棚', lang: 'ja' });
  expect(pickZoneName({ labels: {} }, 'en')).toEqual({ text: '' });
});
