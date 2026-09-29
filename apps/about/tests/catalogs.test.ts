import { expect, test } from 'bun:test';
import { uiLocales as webLocales } from '../../web/i18n/define.ts';
import { featureIds, features, milestoneHorizon } from '../src/features.ts';
import { awaitsTranslation } from '../src/i18n/define.ts';
import { catalogs } from '../src/i18n/messages/index.ts';
import { localeNames, uiLocales } from '../src/i18n/locales.ts';
import { pageIds } from '../src/pages.ts';

/** Every leaf of a catalog as `path -> string`. */
function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (typeof value !== 'object' || value === null)
    throw new Error(`${prefix} is not a string or object`);
  return Object.entries(value).flatMap(([key, item]) =>
    leaves(item, prefix ? `${prefix}.${key}` : key),
  );
}

test('the site has the same eight interface locales as the web app', () => {
  expect([...uiLocales]).toEqual([...webLocales]);
  expect(Object.keys(localeNames).sort()).toEqual([...uiLocales].sort());
});

test('every catalog has every key in every locale, with no empty text', () => {
  for (const [name, catalog] of Object.entries(catalogs)) {
    const english = leaves(catalog.en);
    expect(english.length, name).toBeGreaterThan(0);
    for (const locale of uiLocales) {
      const localized = leaves(catalog[locale]);
      expect(
        localized.map(([path]) => path),
        `${name}/${locale} keys`,
      ).toEqual(english.map(([path]) => path));
      for (const [path, text] of localized)
        expect(text.trim(), `${name}/${locale}/${path}`).not.toBe('');
    }
  }
});

test('placeholders such as {n} survive translation', () => {
  for (const [name, catalog] of Object.entries(catalogs)) {
    const english = new Map(leaves(catalog.en));
    for (const locale of uiLocales) {
      for (const [path, text] of leaves(catalog[locale])) {
        const wanted = (english.get(path)!.match(/\{\w+\}/g) ?? []).sort();
        expect((text.match(/\{\w+\}/g) ?? []).sort(), `${name}/${locale}/${path}`).toEqual(wanted);
      }
    }
  }
});

test('the catalogs awaiting translation are exactly the ones G-482 translates', () => {
  // G-481 wrote these in English only (`defineEnglishCopy`); G-482 translates them and
  // empties this list. Nothing else may fall back to English.
  expect(
    Object.entries(catalogs)
      .filter(([, catalog]) => awaitsTranslation(catalog))
      .map(([name]) => name)
      .sort(),
  ).toEqual(
    [
      'features',
      'illustrations',
      'home',
      'reading',
      'light-novels',
      'serial-fiction',
      'acgn',
      'wikis',
      'agents',
      'communities',
      'distribution',
      'developers',
      'trust',
      'roadmap',
    ].sort(),
  );
});

test('only the English catalogs may contain untranslated English sentences', () => {
  // A copy-paste of English into another locale would pass the key check; the
  // long, sentence-like values of a locale must differ from English unless they are names.
  for (const [name, catalog] of Object.entries(catalogs)) {
    if (awaitsTranslation(catalog)) continue;
    const english = new Map(leaves(catalog.en));
    for (const locale of uiLocales.filter((locale) => locale !== 'en')) {
      for (const [path, text] of leaves(catalog[locale])) {
        if (text.length > 40) expect(text, `${name}/${locale}/${path}`).not.toBe(english.get(path));
      }
    }
  }
});

test('every feature has a statement, and every page has a name, a summary and search text', () => {
  for (const locale of uiLocales) {
    expect(Object.keys(catalogs.features[locale]).sort(), locale).toEqual([...featureIds].sort());
    expect(Object.keys(catalogs.site[locale].pages).sort(), locale).toEqual([...pageIds].sort());
    for (const page of [
      'home',
      'roadmap',
      'reading',
      'light-novels',
      'serial-fiction',
      'acgn',
      'wikis',
      'agents',
      'communities',
      'distribution',
      'developers',
      'trust',
    ] as const) {
      const { meta } = catalogs[page][locale];
      expect(meta.title.length, `${page}/${locale} title`).toBeLessThanOrEqual(90);
      expect(meta.description.length, `${page}/${locale} description`).toBeLessThanOrEqual(220);
    }
  }
});

test('every feature takes its status from the milestone that delivers it', () => {
  for (const id of featureIds) {
    const { status, horizon, milestone } = features[id];
    if (!milestone) {
      // Only the site's own policies can be available before launch.
      expect(id).toBe('no-trackers');
      expect([status, horizon]).toEqual(['available', 'available']);
      continue;
    }
    expect(horizon, id).toBe(milestoneHorizon[milestone]);
    expect(status, id).toBe(horizon === 'now' ? 'in-development' : 'planned');
  }
});
