import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CatalogueError, compileCatalogue, type CatalogueViolation } from '../src/compile.ts';
import { validateRelease, type Release } from '../src/index.ts';

const prefixes = {
  linkml: 'https://w3id.org/linkml/',
  schema: 'http://schema.org/',
  ex: 'https://example.org/',
  wd: 'https://www.wikidata.org/entity/',
};

type SlotDefinition = {
  slot_uri: string;
  range?: string;
  pattern?: string;
  description?: string;
  multivalued?: boolean;
  exact_mappings?: string[];
  annotations: { datatype: string; units?: string };
};

const CANONICAL_LANGUAGE = '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$';

async function compileFixture(
  classes: Record<string, { class_uri: string; slots: string[]; annotations?: { facets: string } }>,
  slots: Record<string, SlotDefinition>,
): Promise<Release> {
  const types = Object.values(classes).map((item) => item.class_uri);
  const properties = Object.values(slots).map((item) => item.slot_uri);
  return compileCatalogue({
    root: 'fixture.yaml',
    schemas: {
      'fixture.yaml': JSON.stringify({
        id: 'https://rezics.com/catalogue/fixture',
        name: 'fixture',
        version: '1.0.0',
        prefixes,
        default_range: 'string',
        imports: ['linkml:types'],
        classes,
        slots,
      }),
    },
    presentation: {
      en: JSON.stringify({
        types: Object.fromEntries(types.map((key) => [key, key])),
        properties: Object.fromEntries(properties.map((key) => [key, key])),
      }),
    },
  });
}

async function facetViolations(
  classes: Record<string, { class_uri: string; slots: string[]; annotations?: { facets: string } }>,
  slots: Record<string, SlotDefinition>,
): Promise<CatalogueViolation[]> {
  try {
    await compileFixture(classes, slots);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  return [];
}

test('a string property with a pattern may be a facet and one without may not', async () => {
  const code = {
    slot_uri: 'ex:code',
    pattern: '^[a-z]{2}$',
    annotations: { datatype: 'string' },
  };
  const prose = {
    slot_uri: 'ex:prose',
    annotations: { datatype: 'string' },
  };
  const accepted = await compileFixture(
    { Work: { class_uri: 'ex:Work', slots: ['code'], annotations: { facets: 'code' } } },
    { code },
  );
  expect(accepted.types['ex:Work']!.facets).toEqual(['ex:code']);
  expect(validateRelease(accepted)).toEqual([]);

  const withoutPattern = structuredClone(accepted);
  const value = withoutPattern.properties['ex:code']!.value as { pattern?: string };
  delete value.pattern;
  expect(validateRelease(withoutPattern)).toEqual([{ pointer: '/types/ex:Work/facets/0', code: 'invalid' }]);

  const refused = await facetViolations(
    { Work: { class_uri: 'ex:Work', slots: ['prose'], annotations: { facets: 'prose' } } },
    { prose },
  );
  expect(refused).toEqual([
    {
      file: 'fixture.yaml',
      pointer: '/classes/Work/annotations/facets',
      code: 'invalid',
      message: 'Facet slot prose has unfilterable datatype string',
    },
  ]);
});

test('language tags are accepted only in canonical case', async () => {
  const core = Bun.YAML.parse(readFileSync(new URL('../catalogue/core.yaml', import.meta.url), 'utf8')) as {
    slots: { inLanguage: SlotDefinition };
  };
  const release = await compileFixture(
    { Work: { class_uri: 'ex:Work', slots: ['inLanguage'] } },
    { inLanguage: core.slots.inLanguage },
  );
  const pattern = (release.properties['schema:inLanguage']!.value as { pattern?: string }).pattern;
  expect(pattern).toBe(CANONICAL_LANGUAGE);
  const matches = (tag: string) => new RegExp(pattern ?? '', 'u').exec(tag)?.[0] === tag;
  expect(['ja', 'zh-Hant', 'pt-BR', 'es-419'].filter((tag) => !matches(tag))).toEqual([]);
  expect(['zh-hant', 'pt-br', 'EN'].filter(matches)).toEqual([]);
});
