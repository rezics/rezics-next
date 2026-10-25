import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease, type ContextSettings } from '../src/index.ts';

const prefixes = {
  linkml: 'https://w3id.org/linkml/',
  schema: 'http://schema.org/',
};

function catalogue(properties: string[]) {
  const slots = Object.fromEntries(
    properties.map((property) => [
      property.slice('schema:'.length),
      { slot_uri: property, annotations: { datatype: 'string' } },
    ]),
  );
  return {
    root: 'fixture.yaml',
    schemas: {
      'fixture.yaml': JSON.stringify({
        id: 'https://rezics.com/catalogue/fixture',
        name: 'fixture',
        version: '1.0.0',
        prefixes,
        default_range: 'string',
        imports: ['linkml:types'],
        classes: { Thing: { class_uri: 'schema:Thing', slots: Object.keys(slots) } },
        slots,
      }),
    },
    presentation: {
      en: JSON.stringify({
        types: { 'schema:Thing': 'thing' },
        properties: Object.fromEntries(properties.map((property) => [property, property])),
      }),
    },
  };
}

const settings = (labels: Record<string, string>, defaults: Record<string, string>) =>
  JSON.stringify({ labels, defaults });

async function violations(contexts: Record<string, string>) {
  try {
    await compileCatalogue({ ...catalogue(['schema:genre', 'schema:keywords']), contexts });
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations.map(({ file, pointer, code }) => ({ file, pointer, code }));
  }
  throw new Error('Expected context settings to fail compilation');
}

test('context settings files compile into the release in id order', async () => {
  const base = catalogue(['schema:genre', 'schema:keywords']);
  const release = await compileCatalogue({
    ...base,
    contexts: {
      manga: settings({ ja: '漫画', en: 'Manga' }, { 'schema:keywords': 'suppress', 'schema:genre': 'inherit' }),
      anime: settings({ en: 'Anime' }, { 'schema:genre': 'inherit' }),
    },
  });
  expect(Object.keys(release.contexts ?? {})).toEqual(['anime', 'manga']);
  expect(release.contexts?.anime).toEqual({
    labels: { en: 'Anime' },
    defaults: { 'schema:genre': 'inherit' },
  });
  expect(release.contexts?.manga).toEqual({
    labels: { en: 'Manga', ja: '漫画' },
    defaults: { 'schema:genre': 'inherit', 'schema:keywords': 'suppress' },
  });
  expect(Object.keys(release.contexts?.manga?.labels ?? {})).toEqual(['en', 'ja']);
  expect(Object.keys(release.contexts?.manga?.defaults ?? {})).toEqual(['schema:genre', 'schema:keywords']);
  const plain = await compileCatalogue(base);
  expect(plain.contexts).toBeUndefined();
  expect(Object.hasOwn(plain, 'contexts')).toBe(false);
  expect(validateRelease(release)).toEqual([]);
  expect(validateRelease(plain)).toEqual([]);
});

test('settings naming an unknown property, a replace default or exceeding a limit are refused at compilation and by validateRelease', async () => {
  const base = catalogue(['schema:genre', 'schema:keywords']);
  const release = await compileCatalogue({
    ...base,
    contexts: { anime: settings({ en: 'Anime' }, { 'schema:keywords': 'suppress' }) },
  });
  expect(await violations({ anime: settings({ en: 'Anime' }, { 'schema:missing': 'inherit' }) })).toEqual([
    { file: 'contexts/anime', pointer: '/contexts/anime/defaults/schema:missing', code: 'invalid' },
  ]);
  expect(await violations({ anime: settings({ en: 'Anime' }, { 'schema:keywords': 'replace' }) })).toEqual([
    { file: 'contexts/anime', pointer: '/contexts/anime/defaults/schema:keywords', code: 'invalid' },
  ]);
  const manyDefaults = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`schema:p${String(index).padStart(2, '0')}`, 'inherit']),
  );
  expect(await violations({ anime: settings({ en: 'Anime' }, manyDefaults) })).toEqual([
    { file: 'contexts/anime', pointer: '/contexts/anime/defaults', code: 'limit' },
  ]);
  const manySettings = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [
      `n${String(index).padStart(3, '0')}`,
      settings({ en: 'Context' }, { 'schema:keywords': 'inherit' }),
    ]),
  );
  expect(await violations(manySettings)).toEqual([{ file: 'contexts', pointer: '/contexts', code: 'limit' }]);

  const unknown = structuredClone(release);
  unknown.contexts!.anime!.defaults['schema:missing'] = 'inherit';
  expect(validateRelease(unknown)).toEqual([{ pointer: '/contexts/anime/defaults/schema:missing', code: 'invalid' }]);
  const replaced = structuredClone(release) as {
    contexts: Record<string, { labels: ContextSettings['labels']; defaults: Record<string, string> }>;
  };
  replaced.contexts.anime!.defaults['schema:keywords'] = 'replace';
  expect(validateRelease(replaced)).toEqual([{ pointer: '/contexts/anime/defaults/schema:keywords', code: 'invalid' }]);
  const crowded = structuredClone(release);
  crowded.contexts!.anime!.defaults = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`schema:p${String(index).padStart(2, '0')}`, 'inherit' as const]),
  );
  expect(validateRelease(crowded)).toEqual([{ pointer: '/contexts/anime/defaults', code: 'limit' }]);
  const tooMany = structuredClone(release);
  tooMany.contexts = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [
      `n${String(index).padStart(3, '0')}`,
      { labels: { en: 'Context' }, defaults: { 'schema:keywords': 'inherit' as const } },
    ]),
  );
  expect(validateRelease(tooMany)).toEqual([{ pointer: '/contexts', code: 'limit' }]);
});

test('every contexts file is bundled with no code edit', () => {
  const sources = bundledSources();
  const directory = new URL('../contexts/', import.meta.url);
  let names: string[] = [];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.replace(/\.yaml$/u, ''))
      .sort();
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  expect(Object.keys(sources.contexts).sort()).toEqual(names);
  for (const name of names)
    expect(sources.contexts[name]).toBe(readFileSync(new URL(`${name}.yaml`, directory), 'utf8'));
  expect(Object.keys(sources.presentation).every((key) => !key.startsWith('contexts'))).toBe(true);
});
