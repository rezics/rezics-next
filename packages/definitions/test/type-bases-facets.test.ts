import { expect, test } from 'bun:test';
import { CatalogueError, compileCatalogue, type CatalogueViolation } from '../src/compile.ts';

const prefixes = {
  linkml: 'https://w3id.org/linkml/',
  ex: 'https://example.org/',
  wd: 'https://www.wikidata.org/entity/',
};

type ClassDefinition = {
  abstract?: boolean;
  class_uri?: string;
  is_a?: string;
  slots?: string[];
  annotations?: { facets?: string };
};
type SlotDefinition = {
  slot_uri: string;
  range?: string;
  exact_mappings?: string[];
  annotations: { datatype: string; units?: string };
};

async function compileFixture(classes: Record<string, ClassDefinition>, slots: Record<string, SlotDefinition>) {
  const types = [
    ...new Set(
      Object.values(classes)
        .filter((item) => !item.abstract)
        .map((item) => item.class_uri),
    ),
  ].filter((item): item is string => Boolean(item));
  const properties = [...new Set(Object.values(slots).map((item) => item.slot_uri))];
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
  classes: Record<string, ClassDefinition>,
  slots: Record<string, SlotDefinition>,
): Promise<CatalogueViolation[]> {
  try {
    await compileFixture(classes, slots);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  throw new Error('Expected facet compilation to fail');
}

const slot = (
  name: string,
  datatype: string,
  range = 'string',
  extra: Partial<SlotDefinition> = {},
): SlotDefinition => ({
  slot_uri: `ex:${name}`,
  range,
  annotations: { datatype },
  ...extra,
});

test('a type lists its structural bases nearest first', async () => {
  const release = await compileFixture(
    {
      Thing: { abstract: true },
      CreativeWork: { abstract: true, is_a: 'Thing', class_uri: 'ex:CreativeWork' },
      LaunchWork: { abstract: true, is_a: 'CreativeWork' },
      VideoGame: { abstract: true, is_a: 'LaunchWork', class_uri: 'ex:VideoGame' },
      BangumiVideoGame: { is_a: 'VideoGame', class_uri: 'ex:VideoGame' },
      VisualNovel: { is_a: 'VideoGame', class_uri: 'wd:Q689445' },
    },
    {},
  );

  expect(release.types['wd:Q689445']!.bases).toEqual(['ex:VideoGame', 'ex:CreativeWork']);
  expect(release.types['ex:VideoGame']!.bases).toEqual(['ex:CreativeWork']);
});

test("a type registers its facets in display order, inheriting its ancestors' facets", async () => {
  const release = await compileFixture(
    {
      Thing: { abstract: true, slots: ['amount', 'date'], annotations: { facets: 'amount date' } },
      Work: { abstract: true, is_a: 'Thing', slots: ['person'], annotations: { facets: 'person' } },
      Book: {
        is_a: 'Work',
        class_uri: 'ex:Book',
        slots: ['published', 'score'],
        annotations: { facets: 'score published' },
      },
      Person: { class_uri: 'ex:Person' },
    },
    {
      amount: slot('amount', 'quantity', 'decimal', { annotations: { datatype: 'quantity', units: '1' } }),
      date: slot('date', 'time', 'date'),
      person: slot('person', 'wikibase-item', 'Person'),
      published: slot('published', 'time', 'date'),
      score: slot('score', 'quantity', 'decimal', { annotations: { datatype: 'quantity', units: '1' } }),
    },
  );

  expect(release.types['ex:Book']!.facets).toEqual(['ex:amount', 'ex:date', 'ex:person', 'ex:score', 'ex:published']);
  expect(release.types['ex:Person']!.facets).toEqual([]);
});

test('facets outside the type, of an unfilterable datatype, repeated or over the limit are refused', async () => {
  const outside = await facetViolations(
    {
      Bad: { class_uri: 'ex:Bad', annotations: { facets: 'outside' } },
      Owner: { class_uri: 'ex:Owner', slots: ['outside'] },
    },
    { outside: slot('outside', 'quantity', 'decimal', { annotations: { datatype: 'quantity', units: '1' } }) },
  );
  expect(outside.some((violation) => violation.message.includes('outside'))).toBe(true);

  const unfilterable: Array<[string, string, Partial<SlotDefinition>?]> = [
    ['string', 'string'],
    ['external-id', 'string', { exact_mappings: ['wd:P1'] }],
    ['url', 'uri'],
    ['monolingualtext', 'string'],
    ['document', 'string'],
    ['media', 'string'],
  ];
  for (const [datatype, datatypeRange, extra] of unfilterable) {
    const errors = await facetViolations(
      { Bad: { class_uri: 'ex:Bad', slots: ['unfilterable'], annotations: { facets: 'unfilterable' } } },
      { unfilterable: slot('unfilterable', datatype, datatypeRange, extra) },
    );
    expect(errors.some((violation) => violation.message.includes('unfilterable'))).toBe(true);
  }

  const repeated = await facetViolations(
    {
      Base: { abstract: true, slots: ['count'], annotations: { facets: 'count' } },
      Bad: { is_a: 'Base', class_uri: 'ex:Bad', annotations: { facets: 'count' } },
    },
    { count: slot('count', 'quantity', 'decimal', { annotations: { datatype: 'quantity', units: '1' } }) },
  );
  expect(repeated.some((violation) => violation.code === 'duplicate' && violation.message.includes('count'))).toBe(
    true,
  );

  const names = Array.from({ length: 17 }, (_, index) => `facet${index}`);
  const overLimit = await facetViolations(
    { Bad: { class_uri: 'ex:Bad', slots: names, annotations: { facets: names.join(' ') } } },
    Object.fromEntries(
      names.map((name) => [
        name,
        slot(name, 'quantity', 'decimal', { annotations: { datatype: 'quantity', units: '1' } }),
      ]),
    ),
  );
  expect(overLimit.some((violation) => violation.message.includes('facet16'))).toBe(true);
});
