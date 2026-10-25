import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { UI_LOCALES, platformRegistry, validateZoneStarter } from '@rezics/composition';
import { bundledRelease } from '../src/bundled.ts';

const VERTICALS = ['book', 'recipe', 'visual-novel', 'game', 'anime', 'manga', 'character', 'series'];

const ALL_FILTERS: Record<string, { type: { in: string[] } }> = {
  book: { type: { in: ['schema:Book'] } },
  recipe: { type: { in: ['schema:Recipe'] } },
  'visual-novel': { type: { in: ['wd:Q689445'] } },
  game: { type: { in: ['schema:VideoGame'] } },
  anime: { type: { in: ['schema:Movie', 'schema:TVSeries'] } },
  manga: { type: { in: ['schema:ComicSeries'] } },
  character: { type: { in: ['wd:Q95074'] } },
  series: { type: { in: ['wd:Q7725310', 'schema:BookSeries'] } },
};

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function expectLocales(labels: unknown) {
  const record = labels as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...UI_LOCALES].sort());
  for (const locale of UI_LOCALES) {
    expect(typeof record[locale]).toBe('string');
    expect(record[locale]).not.toBe('');
  }
}

test('each listed vertical ships Context settings, saved filters and a Zone starter', () => {
  for (const group of VERTICALS) {
    const settings = Bun.YAML.parse(read(`contexts/${group}.yaml`)) as { defaults: unknown };
    expect(settings.defaults).toEqual({});
    const filters = Bun.YAML.parse(read(`filters/${group}.yaml`)) as Record<string, { filter: unknown }>;
    expect(filters.all?.filter).toEqual(ALL_FILTERS[group]);
    const starter = JSON.parse(read(`presentation/${group}/zone.json`)) as { pages: unknown; scope: unknown };
    expect(starter.pages).toBeArray();
    expect(starter.scope).toBeArray();
  }
});

test('settings, saved filters and Zone starters carry labels in all eight UI locales', () => {
  for (const group of VERTICALS) {
    const settings = Bun.YAML.parse(read(`contexts/${group}.yaml`)) as { labels: unknown };
    expectLocales(settings.labels);
    const filters = Bun.YAML.parse(read(`filters/${group}.yaml`)) as Record<string, { labels: unknown }>;
    for (const saved of Object.values(filters)) expectLocales(saved.labels);
    const starter = JSON.parse(read(`presentation/${group}/zone.json`)) as { labels: unknown };
    expectLocales(starter.labels);
  }
});

test("every Zone starter is valid against the platform registry and the release's saved filters", () => {
  const filters = new Set(Object.keys(bundledRelease.filters ?? {}));
  for (const group of VERTICALS) {
    const starter = JSON.parse(read(`presentation/${group}/zone.json`)) as { scope?: unknown };
    expect(validateZoneStarter(platformRegistry, starter, { filters })).toEqual([]);
    const scope = Array.isArray(starter.scope) ? [...starter.scope].sort() : [];
    expect(scope).toEqual([...filters].filter((id) => id.startsWith(`${group}/`)).sort());
  }
});

const SHARED_SCHEMAS = ['classification', 'core', 'rezics', 'works'];

function typeListTypes(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) typeListTypes(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    const node = value as { type?: unknown; props?: { types?: unknown } };
    if (node.type === 'TypeList') found.push(node.props?.types);
    for (const entry of Object.values(value)) typeListTypes(entry, found);
  }
  return found;
}

test('every launch vertical ships Context settings, saved filters and a Zone starter', () => {
  const schemas = readdirSync(new URL('../catalogue', import.meta.url))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .sort();
  const verticals = schemas.filter((name) => !SHARED_SCHEMAS.includes(name));
  expect(verticals).toEqual([...VERTICALS].sort());
  expect(verticals).toEqual([
    'anime',
    'book',
    'character',
    'game',
    'manga',
    'recipe',
    'series',
    'visual-novel',
  ]);
});

test("every Zone starter home lists its vertical's works", () => {
  for (const group of VERTICALS) {
    const filters = Bun.YAML.parse(read(`filters/${group}.yaml`)) as {
      all: { filter: { type: { in: string[] } } };
    };
    const starter = JSON.parse(read(`presentation/${group}/zone.json`)) as {
      pages: { route: string; document: unknown }[];
    };
    const home = starter.pages.filter((page) => page.route === '');
    expect(home).toHaveLength(1);
    expect(typeListTypes(home[0]!.document)).toEqual([filters.all.filter.type.in]);
  }
});
