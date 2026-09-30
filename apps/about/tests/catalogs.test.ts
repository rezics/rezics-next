import { expect, test } from 'bun:test';
import { uiLocales as webLocales } from '../../web/i18n/define.ts';
import { featureIds, features, milestones } from '../src/features.ts';
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

test('every catalog is translated with no English fallback', () => {
  expect(
    Object.entries(catalogs)
      .filter(([, catalog]) => awaitsTranslation(catalog))
      .map(([name]) => name),
  ).toEqual([]);
});

test('only the English catalogs may contain untranslated English sentences', () => {
  // A copy-paste of English into another locale would pass the key check; the
  // long, sentence-like values of a locale must differ from English unless they are names.
  for (const [name, catalog] of Object.entries(catalogs)) {
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

test('launch capabilities and principles are distinct from sourced post-launch claims', () => {
  const principles = [
    'open-source',
    'agent-disclosure',
    'drm-free',
    'ai-disclosure',
    'no-training',
    'no-trackers',
  ] as const;
  for (const id of principles) {
    expect(features[id], id).toMatchObject({ status: 'launch', milestone: undefined });
    expect(features[id].source, id).toBeUndefined();
  }
  const later = featureIds.filter((id) => features[id].status === 'later');
  expect(later).toEqual([]);
  expect(features['world-visuals']).toMatchObject({
    status: 'launch',
    milestone: 'M7',
  });
  expect(catalogs.features.en['world-visuals'].title).toBe('Maps, relationships and timelines');
  for (const locale of uiLocales)
    expect(catalogs.features[locale]['world-visuals'].title, locale).not.toMatch(
      /family trees|家族樹|家族树|家系図|가계도|Stammbäume|arbres|árboles/i,
    );
  for (const id of featureIds) {
    const entry = features[id];
    if (entry.milestone) {
      expect(milestones, id).toContain(entry.milestone);
      expect(entry.status, id).toBe('launch');
    } else if (entry.status === 'launch') {
      expect(principles as readonly string[], id).toContain(id);
    }
  }
});

test('Realm is an English product name; other locales use their word for a community', () => {
  for (const [name, catalog] of Object.entries(catalogs)) {
    for (const locale of uiLocales.filter((locale) => locale !== 'en')) {
      for (const [path, text] of leaves(catalog[locale]))
        expect(text, `${name}/${locale}/${path}`).not.toMatch(/\bRealms?\b/);
    }
  }
});
