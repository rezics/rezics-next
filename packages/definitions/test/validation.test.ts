import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';
import { DATA_TYPES, RELEASE_FORMAT, validateRelease, valueSchema, type DataType, type Release } from '../src/index.ts';

function fixture(datatype: DataType = 'string'): Release {
  return {
    format: RELEASE_FORMAT,
    catalogue: { id: 'urn:catalogue:test', version: '1' },
    generator: { name: 'test', version: '1' },
    prefixes: { ex: 'https://example.org/' },
    types: {
      'ex:T': {
        iri: 'https://example.org/T',
        labels: { en: 'type' },
        mappings: [],
        bases: [],
        properties: ['ex:p'],
        facets: [],
      },
    },
    properties: {
      'ex:p': {
        iri: 'https://example.org/p',
        labels: { en: 'property' },
        mappings: [],
        datatype,
        multivalued: false,
        ...(datatype === 'wikibase-item' ? { targets: ['ex:T'] } : {}),
        ...(datatype === 'quantity' ? { units: ['1'] } : {}),
        qualifiers: [],
        value: valueSchema(datatype, datatype === 'quantity' ? { units: ['1'] } : {}),
      },
    },
  };
}

test('every fixed value schema validates, including nested pattern schemas', () => {
  for (const datatype of DATA_TYPES) expect(validateRelease(fixture(datatype))).toEqual([]);
  const draft = fixture('monolingualtext');
  draft.properties['ex:p']!.value = valueSchema('monolingualtext', { pattern: '^\\S' });
  expect(validateRelease(draft)).toEqual([]);
  draft.properties['ex:p']!.value = valueSchema('monolingualtext', { pattern: '^(a+)+$' });
  expect(validateRelease(draft)).toEqual([
    { pointer: '/properties/ex:p/value/properties/text/pattern', code: 'unsafe_pattern' },
  ]);
});

test('collections and canonical UTF-8 size are bounded before validation', () => {
  const properties = fixture();
  for (let i = 0; i < 4097; i++) properties.properties[`ex:p${i}`] = properties.properties['ex:p']!;
  expect(validateRelease(properties)).toEqual([{ pointer: '/properties', code: 'limit' }]);
  const type = fixture();
  type.types['ex:T']!.properties = Array.from({ length: 65 }, (_, i) => `ex:p${i}`);
  expect(validateRelease(type)).toEqual([{ pointer: '/types/ex:T/properties', code: 'limit' }]);
  const size = fixture();
  size.generator.name = '界'.repeat(1_400_000);
  expect(validateRelease(size)).toEqual([{ pointer: '', code: 'limit' }]);
});

test('required and unknown members use escaped, sorted, unique and capped pointers', () => {
  const draft = fixture() as Release & Record<string, unknown>;
  for (let i = 99; i >= 0; i--) draft[`extra/${i}~`] = null;
  const issues = validateRelease(draft);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues.length).toBeLessThanOrEqual(64);
  expect(
    issues.every(({ pointer, code }) => pointer.startsWith('/extra~1') && pointer.endsWith('~0') && code === 'invalid'),
  ).toBe(true);
  expect(issues.map(({ pointer }) => pointer)).toEqual(issues.map(({ pointer }) => pointer).sort());
  const capped = fixture();
  capped.types['ex:T']!.mappings = Array.from({ length: 100 }, (_, i) => `missing:${String(i).padStart(3, '0')}`);
  expect(validateRelease(capped)).toHaveLength(64);
  const missing = fixture();
  Reflect.deleteProperty(missing.properties['ex:p']!, 'multivalued');
  expect(validateRelease(missing)).toEqual([{ pointer: '/properties/ex:p/multivalued', code: 'invalid' }]);
});

test('lists are sorted, references are own keys, and quantity bounds are ordered', () => {
  const draft = fixture();
  draft.properties['ex:p']!.mappings = ['ex:z', 'ex:a'];
  expect(validateRelease(draft)).toEqual([{ pointer: '/properties/ex:p/mappings/1', code: 'invalid' }]);
  draft.properties['ex:p']!.mappings = [];
  draft.properties['ex:p']!.qualifiers = ['ex:constructor'];
  expect(validateRelease(draft).length).toBeGreaterThan(0);
  const quantity = fixture('quantity');
  quantity.properties['ex:p']!.minimum = 2;
  quantity.properties['ex:p']!.maximum = 1;
  expect(validateRelease(quantity)).toEqual([{ pointer: '/properties/ex:p/maximum', code: 'invalid' }]);
});

test('bases are CURIEs and facets are registered facetable properties', () => {
  const type = fixture();
  type.types['ex:T']!.bases = ['missing:Base'];
  expect(validateRelease(type)).toEqual([{ pointer: '/types/ex:T/bases/0', code: 'invalid' }]);

  const facets = fixture('quantity');
  facets.types['ex:T']!.facets = ['ex:p'];
  expect(validateRelease(facets)).toEqual([]);
  facets.properties['ex:p']!.datatype = 'string';
  Reflect.deleteProperty(facets.properties['ex:p']!, 'units');
  facets.properties['ex:p']!.value = valueSchema('string');
  expect(validateRelease(facets)).toEqual([{ pointer: '/types/ex:T/facets/0', code: 'invalid' }]);

  const outside = fixture();
  outside.properties['ex:outside'] = { ...outside.properties['ex:p']!, iri: 'https://example.org/outside' };
  outside.types['ex:T']!.facets = ['ex:outside'];
  expect(validateRelease(outside)).toEqual([{ pointer: '/types/ex:T/facets/0', code: 'invalid' }]);

  const duplicate = fixture('quantity');
  duplicate.types['ex:T']!.facets = ['ex:p', 'ex:p'];
  expect(validateRelease(duplicate)).toEqual([{ pointer: '/types/ex:T/facets', code: 'invalid' }]);

  const crowded = fixture();
  for (let index = 0; index < 17; index++) {
    const key = `ex:p${index}`;
    crowded.properties[key] = { ...crowded.properties['ex:p']!, iri: `https://example.org/p${index}` };
    crowded.types['ex:T']!.properties.push(key);
    crowded.types['ex:T']!.facets.push(key);
  }
  expect(validateRelease(crowded)).toEqual([]);
  const last = 'ex:p17';
  crowded.properties[last] = { ...crowded.properties['ex:p']!, iri: 'https://example.org/p17' };
  crowded.types['ex:T']!.properties.push(last);
  crowded.types['ex:T']!.facets.push(last);
  expect(validateRelease(crowded)).toEqual([{ pointer: '/types/ex:T/facets', code: 'limit' }]);

  const missing = fixture() as Release & { types: Record<string, Record<string, unknown>> };
  Reflect.deleteProperty(missing.types['ex:T']!, 'bases');
  Reflect.deleteProperty(missing.types['ex:T']!, 'facets');
  expect(validateRelease(missing)).toEqual([
    { pointer: '/types/ex:T/bases', code: 'invalid' },
    { pointer: '/types/ex:T/facets', code: 'invalid' },
  ]);
});

test('invalid pattern lengths and malformed JSON values fail without throwing', () => {
  const draft = fixture();
  draft.properties['ex:p']!.value = valueSchema('string', { pattern: 'a'.repeat(257) });
  expect(validateRelease(draft)).toEqual([{ pointer: '/properties/ex:p/value/pattern', code: 'unsafe_pattern' }]);
  for (const value of [undefined, NaN, Infinity, 1n, { broken: '\ud800' }]) {
    expect(() => validateRelease(value)).not.toThrow();
    expect(validateRelease(value).length).toBeGreaterThan(0);
  }
});

test('schema rejects unknown members in nested records and value schema nodes', () => {
  const validator = Compile(schema);
  const draft = fixture();
  expect(validator.Check(draft)).toBe(true);
  Object.assign(draft.properties['ex:p']!.value, { secret: true });
  expect(validateRelease(draft)).toEqual([{ pointer: '/properties/ex:p/value/secret', code: 'invalid' }]);
  expect(validator.Check(draft)).toBe(false);
});

test('name and IRI patterns consume the entire member, including trailing newlines', () => {
  for (const location of ['prefix', 'label', 'iri', 'mapping']) {
    const draft = fixture();
    if (location === 'prefix') draft.prefixes['other\n'] = 'https://example.org/';
    if (location === 'label') draft.types['ex:T']!.labels['ja\n'] = 'label';
    if (location === 'iri') draft.catalogue.id += '\n';
    if (location === 'mapping') draft.types['ex:T']!.mappings = ['ex:T\n'];
    expect(validateRelease(draft).length).toBeGreaterThan(0);
  }
});

test('absolute IRIs reject malformed encodings and authorities', () => {
  for (const iri of ['relative/path', 'https://[invalid', 'https://example.org/%zz']) {
    const draft = fixture();
    draft.catalogue.id = iri;
    expect(validateRelease(draft)).toEqual([{ pointer: '/catalogue/id', code: 'invalid' }]);
  }
});
