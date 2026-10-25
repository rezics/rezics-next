import { expect, test } from 'bun:test';
import { CatalogueError, compileCatalogue, type CatalogueViolation } from '../src/compile.ts';
import { validateRelease, valueSchema } from '../src/index.ts';

function fixture() {
  const schema = {
    id: 'urn:catalogue:profile',
    name: 'profile',
    version: '1',
    prefixes: { linkml: 'https://w3id.org/linkml/', ex: 'https://example.org/', unit: 'https://units.example/' },
    imports: ['linkml:types'],
    classes: {
      Base: { abstract: true, slots: ['title'] },
      Parent: { abstract: true, is_a: 'Base', slot_usage: { title: { pattern: '^[A-Z]' } } },
      Child: { class_uri: 'ex:Child', is_a: 'Parent', slots: ['count', 'relation'] },
      Other: { class_uri: 'ex:Other' },
    },
    slots: {
      title: { slot_uri: 'ex:title', annotations: { datatype: 'string' } },
      position: { slot_uri: 'ex:position', annotations: { datatype: 'string' } },
      relation: {
        slot_uri: 'ex:relation',
        any_of: [{ range: 'Other' }, { range: 'Child' }],
        annotations: { datatype: 'wikibase-item', qualifiers: 'position' },
      },
      count: {
        slot_uri: 'ex:count',
        range: 'decimal',
        minimum_value: 0,
        maximum_value: 10,
        annotations: { datatype: 'quantity', units: 'unit:second 1' },
      },
    },
  };
  const labels = {
    types: { 'ex:Child': 'child', 'ex:Other': 'other' },
    properties: { 'ex:title': 'title', 'ex:position': 'position', 'ex:relation': 'relation', 'ex:count': 'count' },
  };
  return {
    schema,
    labels,
    input: () => ({
      root: 'main.yaml',
      schemas: { 'main.yaml': JSON.stringify(schema) },
      presentation: { en: JSON.stringify(labels) },
    }),
  };
}
async function violations(input: Parameters<typeof compileCatalogue>[0]): Promise<CatalogueViolation[]> {
  try {
    await compileCatalogue(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  throw new Error('Expected catalogue violations');
}

test('LinkML induces slot_usage through multiple ancestors and retains unused qualifier slots', async () => {
  const release = await compileCatalogue(fixture().input());
  expect(validateRelease(release)).toEqual([]);
  expect(release.types['ex:Child']!.properties).toEqual(['ex:count', 'ex:relation', 'ex:title']);
  expect(release.properties['ex:title']!.value).toEqual(valueSchema('string', { pattern: '^[A-Z]' }));
  expect(release.properties['ex:relation']!.targets).toEqual(['ex:Child', 'ex:Other']);
  expect(release.properties['ex:relation']!.qualifiers).toEqual(['ex:position']);
  expect(release.properties['ex:count']!.units).toEqual(['1', 'https://units.example/second']);
  expect(release.properties['ex:count']!.value).toEqual(
    valueSchema('quantity', { units: ['1', 'https://units.example/second'] }),
  );
  expect(release.prefixes).toEqual({ ex: 'https://example.org/' });
});

test('imported terms use their own prefixes even when the root declares none', async () => {
  const f = fixture();
  const input = f.input() as Parameters<typeof compileCatalogue>[0];
  input.schemas['root.yaml'] = JSON.stringify({
    id: 'urn:catalogue:root',
    name: 'root',
    version: '2',
    imports: ['main'],
  });
  input.root = 'root.yaml';
  const release = await compileCatalogue(input);
  expect(release.catalogue).toEqual({ id: 'urn:catalogue:root', version: '2' });
  expect(release.properties['ex:title']!.iri).toBe('https://example.org/title');
});

test('profile diagnostics escape pointers, sort, cap results, and precede labels and LinkML', async () => {
  const f = fixture();
  const source = {
    ...f.schema,
    'a/b~c': true,
    ...Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`unknown${i}`, true])),
  };
  const input = f.input();
  input.schemas['main.yaml'] = JSON.stringify(source);
  input.presentation.en = '[';
  const errors = await violations(input);
  expect(errors).toHaveLength(64);
  expect(errors[0]!.pointer).toBe('/a~1b~0c');
  expect(errors.every((e) => e.file === 'main.yaml' && e.code === 'unsupported')).toBe(true);
  const tooMany = { ...input, schemas: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`${i}.yaml`, '{}'])) };
  expect((await violations(tooMany)).some((e) => e.code === 'limit' && e.pointer === '')).toBe(true);
});

test('imports, slot_usage features, and every pattern are checked before loading', async () => {
  const f = fixture();
  const input = f.input();
  input.schemas['main.yaml'] = JSON.stringify({
    ...f.schema,
    imports: ['https://example.org/remote'],
    classes: { Base: { abstract: true, slot_usage: { title: { slot_uri: 'ex:other', pattern: '[' } } } },
    slots: { title: { ...f.schema.slots.title, pattern: 'x'.repeat(257) } },
  });
  expect((await violations(input)).map((e) => [e.pointer, e.code])).toEqual([
    ['/classes/Base/slot_usage/title/pattern', 'unsafe_pattern'],
    ['/classes/Base/slot_usage/title/slot_uri', 'unsupported'],
    ['/imports/0', 'unsupported'],
    ['/slots/title/pattern', 'unsafe_pattern'],
  ]);
});

test('labels reject unsupported members, unknown terms, invalid locales, and missing English', async () => {
  const f = fixture();
  const input = f.input() as Parameters<typeof compileCatalogue>[0];
  input.presentation = {
    ja: JSON.stringify({ ...f.labels, extra: true, properties: { 'ex:unknown': 'unknown' } }),
    bad_tag: '{}',
  };
  const errors = await violations(input);
  expect(errors.some((e) => e.file === 'presentation/ja' && e.pointer === '/extra' && e.code === 'unsupported')).toBe(
    true,
  );
  expect(errors.some((e) => e.pointer === '/properties/ex:unknown' && e.code === 'invalid')).toBe(true);
  expect(errors.some((e) => e.file === 'presentation/bad_tag' && e.code === 'invalid')).toBe(true);
  expect(errors.filter((e) => e.code === 'missing_label')).toHaveLength(6);
});

test('missing explicit slot URIs and nonquantity units or bounds are mapping errors', async () => {
  const f = fixture();
  const input = f.input();
  input.schemas['main.yaml'] = JSON.stringify({
    ...f.schema,
    slots: {
      ...f.schema.slots,
      position: { annotations: { datatype: 'string' } },
      title: { ...f.schema.slots.title, minimum_value: 0, annotations: { datatype: 'string', units: '1' } },
    },
  });
  const errors = await violations(input);
  expect(errors.some((e) => e.pointer === '/slots/position' && e.code === 'invalid')).toBe(true);
  expect(errors.some((e) => e.pointer === '/slots/title/minimum_value' && e.code === 'invalid')).toBe(true);
  expect(errors.some((e) => e.pointer === '/slots/title/annotations/units' && e.code === 'invalid')).toBe(true);
});
