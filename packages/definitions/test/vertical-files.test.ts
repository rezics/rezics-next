import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

const yamlNames = (directory: URL) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name)
    .sort();

const withVertical = (presentation = bundledSources().presentation) => {
  const sources = bundledSources();
  const englishKey = Object.keys(presentation).find((key) => key === 'en' || key.endsWith('/en'))!;
  const english = Bun.YAML.parse(presentation[englishKey]!) as Record<string, Record<string, string>>;
  english.types ??= {};
  english.properties ??= {};
  english.types!['schema:FictionalPerson'] = 'fictional person';
  english.types!['schema:VerticalCharacter'] = 'vertical character';
  english.properties!['schema:relatedPerson'] = 'related person';
  const presentations = { ...presentation, [englishKey]: Bun.YAML.stringify(english) };
  const root = Bun.YAML.parse(sources.schemas['rezics.yaml']!) as Record<string, unknown>;
  root.imports = [...(root.imports as string[]), 'vertical'];
  const vertical = `id: https://rezics.com/catalogue/vertical
name: vertical
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wd: http://www.wikidata.org/entity/
imports:
  - linkml:types
  - core
classes:
  FictionalPerson:
    is_a: Person
    class_uri: schema:FictionalPerson
  AbstractCharacter:
    is_a: Thing
    abstract: true
  VerticalCharacter:
    is_a: AbstractCharacter
    class_uri: schema:VerticalCharacter
slots:
  relatedPerson:
    slot_uri: schema:relatedPerson
    range: Person
    annotations:
      datatype: wikibase-item
`;
  const schemas: Record<string, string> = {
    ...sources.schemas,
    'rezics.yaml': Bun.YAML.stringify(root),
    'vertical.yaml': vertical,
  };
  return {
    root: 'rezics.yaml',
    schemas,
    presentation: presentations,
  };
};

test('a range targets its concrete class and every concrete descendant, including through an abstract class', async () => {
  const release = await compileCatalogue(withVertical());
  expect(release.properties['schema:author']!.targets).toEqual(['schema:Organization', 'schema:Person']);
  expect(release.properties['schema:relatedPerson']!.targets).toEqual(['schema:Person']);
  expect(release.properties['schema:author']!.targets).not.toContain('schema:VerticalCharacter');
});

test('a subclass in another schema file widens a range with no edit to the slot', async () => {
  const input = withVertical();
  expect(input.schemas['core.yaml']).not.toContain('FictionalPerson');
  const release = await compileCatalogue(input);
  expect(release.properties['schema:author']!.targets).toEqual(['schema:Organization', 'schema:Person']);
});

test('labels split across files merge per locale and a term labelled twice in one locale is refused', async () => {
  const sources = bundledSources();
  const bookLabels = Bun.YAML.parse(sources.presentation['book/en']!) as Record<string, Record<string, string>>;
  delete bookLabels.types!['schema:Book'];
  const merged = {
    ...sources.presentation,
    'book/en': Bun.YAML.stringify(bookLabels),
    'other/en': 'types:\n  schema:Book: book\n',
  };
  const release = await compileCatalogue(withVertical(merged));
  expect(release.types['schema:Book']!.labels.en).toBe('book');

  const duplicate = {
    ...merged,
    'z-catalogue/en': 'types:\n  schema:Book: duplicate book\n',
  };
  try {
    await compileCatalogue(withVertical(duplicate));
    throw new Error('Expected duplicate labels to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    expect((error as CatalogueError).violations).toContainEqual(
      expect.objectContaining({
        file: 'presentation/z-catalogue/en',
        pointer: '/types/schema:Book',
        code: 'duplicate',
      }),
    );
  }
});

test('every catalogue and presentation file is bundled with no code edit', () => {
  const sources = bundledSources();
  const catalogue = new URL('../catalogue/', import.meta.url);
  expect(Object.keys(sources.schemas).sort()).toEqual(yamlNames(catalogue));

  const presentation = new URL('../presentation/', import.meta.url);
  const keys: string[] = [];
  const groups = readdirSync(presentation, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const group of groups) {
    const groupLocales = yamlNames(new URL(`${group}/`, presentation)).map((name) => name.replace(/\.yaml$/u, ''));
    expect(groupLocales).toEqual(locales);
    for (const locale of groupLocales) keys.push(`${group}/${locale}`);
  }
  expect(Object.keys(sources.presentation).sort()).toEqual(keys.sort());
});
