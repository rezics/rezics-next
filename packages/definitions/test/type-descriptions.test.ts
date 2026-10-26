import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease } from '../src/index.ts';

const fixture = (presentation: Record<string, string>) => ({
  root: 'main.yaml',
  schemas: {
    'main.yaml': JSON.stringify({
      id: 'urn:catalogue:descriptions',
      name: 'descriptions',
      version: '1',
      prefixes: { ex: 'https://example.org/' },
      classes: { Work: { class_uri: 'ex:Work', description: 'The catalogue contract stays here.' } },
    }),
  },
  presentation: { en: 'types:\n  ex:Work: work\n', ...presentation },
});

test('localized descriptions are optional, independent of labels and need no English gloss', async () => {
  const plain = await compileCatalogue(fixture({}));
  expect(plain.types['ex:Work']).not.toHaveProperty('descriptions');
  const input = fixture({
    ja: 'types:\n  ex:Work: 作品\ntypeDescriptions:\n  ex:Work: 創作物\n',
    'other/zh-Hans': 'typeDescriptions:\n  ex:Work: 创意作品\n',
  });
  const release = await compileCatalogue(input);
  expect(release.types['ex:Work']!.descriptions).toEqual({ ja: '創作物', 'zh-Hans': '创意作品' });
  expect(release.types['ex:Work']!.labels).toEqual({ en: 'work', ja: '作品' });
  expect(await compileCatalogue(input)).toEqual(release);
  expect(validateRelease(release)).toEqual([]);
});

test('description input refuses malformed maps, unknown types, empty text, oversized text and duplicates', async () => {
  for (const typeDescriptions of [
    [],
    'text',
    { 'ex:Unknown': 'unknown' },
    { 'ex:Work': '' },
    { 'ex:Work': 1 },
    { 'ex:Work': 'x'.repeat(1501) },
  ]) {
    await expect(compileCatalogue(fixture({ ja: JSON.stringify({ typeDescriptions }) }))).rejects.toBeInstanceOf(
      CatalogueError,
    );
  }
  const duplicate = fixture({
    ja: 'typeDescriptions:\n  ex:Work: 創作物\n',
    'other/ja': 'typeDescriptions:\n  ex:Work: 別の説明\n',
  });
  try {
    await compileCatalogue(duplicate);
    throw new Error('Expected duplicate descriptions to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    expect((error as CatalogueError).violations).toContainEqual({
      file: 'presentation/other/ja',
      pointer: '/typeDescriptions/ex:Work',
      code: 'duplicate',
      message: 'Term already has a description in this language',
    });
  }
});

test('release descriptions enforce language tags and text bounds without requiring an English entry', async () => {
  const plain = await compileCatalogue(fixture({}));
  for (const descriptions of [{ ja: '' }, { ja: 1 }, { ja: 'x'.repeat(1501) }, { 'ja\n': 'text' }, []]) {
    const release = structuredClone(plain);
    Object.assign(release.types['ex:Work']!, { descriptions });
    expect(validateRelease(release).some((error) => error.pointer.startsWith('/types/ex:Work/descriptions'))).toBe(
      true,
    );
  }
  plain.types['ex:Work']!.descriptions = { ja: '字'.repeat(1500) };
  expect(validateRelease(plain)).toEqual([]);
});

test('bundled type labels and descriptions live with the schema that defines the type', () => {
  const sources = bundledSources();
  const owners = new Map<string, string>();
  for (const [file, source] of Object.entries(sources.schemas)) {
    const schema = Bun.YAML.parse(source) as { classes?: Record<string, { abstract?: boolean; class_uri?: string }> };
    for (const value of Object.values(schema.classes ?? {})) {
      if (value.class_uri && !value.abstract) owners.set(value.class_uri, file.replace(/\.yaml$/u, ''));
    }
  }
  for (const [file, source] of Object.entries(sources.presentation)) {
    const presentation = Bun.YAML.parse(source) as {
      types?: Record<string, string>;
      typeDescriptions?: Record<string, string>;
    };
    for (const key of [...Object.keys(presentation.types ?? {}), ...Object.keys(presentation.typeDescriptions ?? {})]) {
      expect(file.split('/')[0]).toBe(owners.get(key));
      expect(bundledRelease.types[key]).toBeDefined();
    }
  }
});
