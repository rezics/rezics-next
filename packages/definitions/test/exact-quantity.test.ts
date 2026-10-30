import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { Compile } from 'typebox/schema';
import releaseSchema from '../schema/release.json';
import { bundledDigest, bundledRelease } from '../src/bundled.ts';
import { checkBatchWrite } from '../src/bulk.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { DATA_TYPES, RELEASE_FORMAT, releaseDigest, validateRelease, valueSchema, type Release } from '../src/index.ts';
import { checkStatementInput, checkSubjectInput } from '../src/validate.ts';

const INTEGER = '^[+-](?:0|[1-9][0-9]*)$';
const DECIMAL = '^[+-](?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$';
const target = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const reference = { parts: [snak('ex:url', 'https://example.org/exact-quantity/conformance')] };
const statement = (content: unknown, id = 'ex:exact') => ({ ...snak(id, content), references: [reference] });
const subject = (entry: unknown, id = 'ex:exact') => ({
  type: 'ex:Sample',
  labels: { en: 'Generic quantity conformance' },
  statements: { [id]: [entry] },
});
const source = {
  source: 'example',
  external_id: 'quantity',
  record_revision: '1',
  digest: 'a'.repeat(64),
  converter_revision: 'example@1',
  field_group: 'facts',
};
const batch = (entry: unknown) => ({
  commands: [{ op: 'propose', key: 'quantity', source, subject: target, statement: entry }],
});

function fixture(): Release {
  const property = (exact: boolean) => ({
    iri: `https://example.org/${exact ? 'exact' : 'ordinary'}`,
    labels: { en: 'quantity' },
    mappings: [],
    datatype: 'quantity' as const,
    multivalued: true,
    qualifiers: ['ex:exact'],
    units: ['1'],
    minimum: 0,
    maximum: 10,
    value: valueSchema('quantity', { integer: true, units: ['1'], ...(exact ? { exact: true } : {}) }),
  });
  return {
    format: RELEASE_FORMAT,
    catalogue: { id: 'https://example.org/quantity', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: { ex: 'https://example.org/' },
    types: {
      'ex:Sample': {
        iri: 'https://example.org/Sample',
        labels: { en: 'sample' },
        mappings: [],
        bases: [],
        properties: ['ex:exact', 'ex:ordinary', 'ex:url'],
        facets: ['ex:exact'],
      },
    },
    properties: {
      'ex:exact': property(true),
      'ex:ordinary': property(false),
      'ex:url': {
        iri: 'https://example.org/url',
        labels: { en: 'citation' },
        mappings: [],
        datatype: 'url',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('url'),
      },
    },
  };
}

function sourceFixture() {
  const quantity = (exact?: unknown) => ({
    slot_uri: 'ex:quantity',
    range: 'integer',
    minimum_value: 0,
    maximum_value: 10,
    annotations: { datatype: 'quantity', units: '1 unit:second', ...(exact === undefined ? {} : { exact }) },
  });
  const schema = {
    id: 'https://example.org/quantity',
    name: 'quantity',
    version: '1',
    imports: ['linkml:types'],
    prefixes: { ex: 'https://example.org/', linkml: 'https://w3id.org/linkml/', unit: 'https://units.example/' },
    classes: { Sample: { class_uri: 'ex:Sample', slots: ['quantity'] } },
    slots: { quantity: quantity(true) },
  };
  const input = () => ({
    root: 'quantity.yaml',
    schemas: { 'quantity.yaml': JSON.stringify(schema) },
    presentation: {
      en: JSON.stringify({ types: { 'ex:Sample': 'sample' }, properties: { 'ex:quantity': 'quantity' } }),
    },
  });
  return { schema, input, quantity };
}

test('exact schemas contain only amount and unit while ordinary schema bytes retain both bounds', () => {
  for (const integer of [false, true]) {
    const scalar = { type: 'string', pattern: integer ? INTEGER : DECIMAL };
    const ordinary = {
      type: 'object',
      required: ['amount', 'unit'],
      additionalProperties: false,
      properties: { amount: scalar, lowerBound: scalar, upperBound: scalar, unit: { enum: ['1'] } },
    };
    const exact = {
      type: 'object',
      required: ['amount', 'unit'],
      additionalProperties: false,
      properties: { amount: scalar, unit: { enum: ['1'] } },
    };
    expect(JSON.stringify(valueSchema('quantity', { units: ['1'], integer }))).toBe(JSON.stringify(ordinary));
    expect(canonicalize(valueSchema('quantity', { units: ['1'], integer, exact: true }))).toBe(canonicalize(exact));
    const validator = Compile(exact);
    expect(validator.Check({ amount: '+1', unit: '1' })).toBe(true);
    expect(validator.Check({ amount: '+1.2500', unit: '1' })).toBe(!integer);
    for (const bounds of [{ lowerBound: '+1' }, { upperBound: '+1' }, { lowerBound: '+1', upperBound: '+1' }])
      expect(validator.Check({ amount: '+1', unit: '1', ...bounds })).toBe(false);
  }
});

test('the exact option is a true-only quantity opt-in without coercion', () => {
  for (const exact of [false, 'true', 'false', 1, 0, null, undefined, {}, []])
    expect(() => Reflect.apply(valueSchema, undefined, ['quantity', { units: ['1'], exact }])).toThrow(TypeError);
  for (const datatype of DATA_TYPES.filter((datatype) => datatype !== 'quantity'))
    expect(() => valueSchema(datatype, { exact: true })).toThrow(TypeError);
});

test('release validation accepts precisely the two closed fixed quantity variants without a runtime flag', () => {
  const release = fixture();
  expect(Compile(releaseSchema).Check(release)).toBe(true);
  expect(validateRelease(release)).toEqual([]);
  const before = canonicalize(release);
  expect(release.properties['ex:exact']).not.toHaveProperty('exact');
  for (const integer of [false, true]) {
    for (const units of [['1'], ['https://units.example/second'], ['*']]) {
      const copy = fixture();
      copy.properties['ex:exact']!.units = units;
      copy.properties['ex:exact']!.value = valueSchema('quantity', { integer, units, exact: true });
      expect(validateRelease(copy)).toEqual([]);
    }
  }
  const edits: ((value: any) => void)[] = [
    (value) => {
      value.properties.lowerBound = { type: 'string', pattern: INTEGER };
    },
    (value) => {
      value.properties.upperBound = { type: 'string', pattern: INTEGER };
    },
    (value) => {
      delete value.properties.unit;
    },
    (value) => {
      value.properties.unit = { enum: ['2'] };
    },
    (value) => {
      value.properties.amount.pattern = '^[0-9]+$';
    },
    (value) => {
      value.properties.extra = { type: 'string' };
    },
    (value) => {
      value.required = ['amount'];
    },
    (value) => {
      value.additionalProperties = true;
    },
    (value) => {
      value.exact = true;
    },
  ];
  for (const edit of edits) {
    const copy = fixture();
    edit(copy.properties['ex:exact']!.value);
    expect(validateRelease(copy).length).toBeGreaterThan(0);
  }
  const flagged = fixture() as any;
  flagged.properties['ex:exact'].exact = true;
  expect(validateRelease(flagged)).toEqual([{ pointer: '/properties/ex:exact/exact', code: 'invalid' }]);
  expect(canonicalize(release)).toBe(before);
});

test('portable subject statement nested Snak and bulk validation reject either or both exact bounds', () => {
  const release = fixture();
  for (const bounds of [{ lowerBound: '+1' }, { upperBound: '+1' }, { lowerBound: '+1', upperBound: '+1' }]) {
    const content = { amount: '+1', unit: '1', ...bounds };
    const errors = Object.keys(bounds).map((name) => ({
      pointer: `/statement/value/content/${name}`,
      code: 'unknown_field' as const,
    }));
    const entry = statement(content);
    expect(checkStatementInput(entry, release).violations).toEqual(errors);
    expect(checkSubjectInput(subject(entry), release).violations).toEqual(
      errors.map((error) => ({
        ...error,
        pointer: error.pointer.replace('/statement', '/statements/ex:exact/0'),
      })),
    );
    expect(checkBatchWrite(batch(entry), release)).toEqual(
      errors.map((error) => ({
        ...error,
        pointer: `/commands/0${error.pointer}`,
      })),
    );
    for (const nested of ['qualifiers', 'references'] as const) {
      const parent = statement({ amount: '+1', unit: '1' }, 'ex:ordinary');
      const input = {
        ...parent,
        ...(nested === 'qualifiers'
          ? { qualifiers: [snak('ex:exact', content)] }
          : { references: [{ parts: [snak('ex:exact', content)] }] }),
      };
      const path = nested === 'qualifiers' ? '/qualifiers/0' : '/references/0/parts/0';
      expect(checkStatementInput(input, release).violations).toEqual(
        errors.map((error) => ({
          ...error,
          pointer: error.pointer.replace('/statement', `/statement${path}`),
        })),
      );
    }
    expect(checkStatementInput(statement(content, 'ex:ordinary'), release).violations).toEqual([]);
  }
});

test('integer range units and scalar limits remain data and ordinary bound semantics stay unchanged', () => {
  const release = fixture();
  for (const [content, field, code] of [
    [{ amount: '-1', unit: '1' }, 'amount', 'out_of_range'],
    [{ amount: '+11', unit: '1' }, 'amount', 'out_of_range'],
    [{ amount: '+1.5', unit: '1' }, 'amount', 'invalid_format'],
    [{ amount: '+1', unit: 'https://units.example/second' }, 'unit', 'invalid_format'],
    [{ amount: 1, unit: '1' }, 'amount', 'invalid_type'],
    [{ amount: '1', unit: '1' }, 'amount', 'invalid_format'],
    [{ amount: `+${'9'.repeat(127)}`, unit: '1' }, 'amount', 'out_of_range'],
  ] as const)
    expect(checkStatementInput(statement(content), release).violations).toEqual([
      { pointer: `/statement/value/content/${field}`, code },
    ]);
  for (const amount of ['+0', '+10'])
    expect(checkStatementInput(statement({ amount, unit: '1' }), release).violations).toEqual([]);
  for (const type of ['somevalue', 'novalue']) {
    const entry = { ...statement(null), value: { type } };
    expect(checkStatementInput(entry, release).violations).toEqual([]);
  }
  for (const [bound, value] of [
    ['lowerBound', '+2'],
    ['upperBound', '+0'],
    ['lowerBound', '-1'],
    ['upperBound', '+11'],
  ])
    expect(
      checkStatementInput(statement({ amount: '+1', unit: '1', [bound!]: value }, 'ex:ordinary'), release).violations,
    ).toEqual([{ pointer: `/statement/value/content/${bound}`, code: 'out_of_range' }]);
  const decimal = fixture();
  decimal.properties['ex:exact']!.value = valueSchema('quantity', { exact: true, units: ['*'] });
  decimal.properties['ex:exact']!.units = ['*'];
  delete decimal.properties['ex:exact']!.minimum;
  delete decimal.properties['ex:exact']!.maximum;
  expect(validateRelease(decimal)).toEqual([]);
  for (const content of [
    { amount: '-12345678901234567890.000100', unit: 'https://units.example/second' },
    { amount: `+${'9'.repeat(126)}`, unit: '1' },
  ])
    expect(checkStatementInput(statement(content), decimal).violations).toEqual([]);
});

test('LinkML exact annotation compiles integer decimal wildcard and induced fixed variants', async () => {
  const f = sourceFixture();
  const release = await compileCatalogue(f.input());
  expect(release.properties['ex:quantity']).toEqual({
    iri: 'https://example.org/quantity',
    labels: { en: 'quantity' },
    mappings: [],
    datatype: 'quantity',
    multivalued: false,
    qualifiers: [],
    units: ['1', 'https://units.example/second'],
    minimum: 0,
    maximum: 10,
    value: {
      type: 'object',
      required: ['amount', 'unit'],
      additionalProperties: false,
      properties: {
        amount: { type: 'string', pattern: INTEGER },
        unit: { enum: ['1', 'https://units.example/second'] },
      },
    },
  });
  expect(validateRelease(release)).toEqual([]);
  const decimal = f.schema as any;
  decimal.slots.quantity.range = 'decimal';
  decimal.slots.quantity.annotations.units = '*';
  delete decimal.slots.quantity.annotations.exact;
  decimal.classes.Sample.slot_usage = { quantity: { annotations: { exact: true } } };
  const induced = await compileCatalogue(f.input());
  expect(induced.properties['ex:quantity']!.value).toEqual(valueSchema('quantity', { exact: true, units: ['*'] }));
});

test('invalid exact source flags and nonquantity annotations have explicit annotation diagnostics', async () => {
  for (const exact of [false, 'true', 1, null, {}, []]) {
    const f = sourceFixture();
    (f.schema.slots.quantity.annotations as any).exact = exact;
    const error = await compileCatalogue(f.input()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CatalogueError);
    expect((error as CatalogueError).violations).toContainEqual({
      file: 'quantity.yaml',
      pointer: '/slots/quantity/annotations/exact',
      code: 'invalid',
      message: expect.any(String),
    });
  }
  for (const datatype of DATA_TYPES.filter((datatype) => datatype !== 'quantity')) {
    const f = sourceFixture();
    const slot = f.schema.slots.quantity as any;
    slot.annotations = { datatype, exact: true };
    slot.range =
      datatype === 'wikibase-item' ? 'Sample' : datatype === 'time' ? 'date' : datatype === 'url' ? 'uri' : 'string';
    delete slot.minimum_value;
    delete slot.maximum_value;
    const error = await compileCatalogue(f.input()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CatalogueError);
    expect((error as CatalogueError).violations).toContainEqual({
      file: 'quantity.yaml',
      pointer: '/slots/quantity/annotations/exact',
      code: 'invalid',
      message: expect.any(String),
    });
  }
});

test('existing immutable bundled release still validates and retains its canonical digest', () => {
  expect(validateRelease(bundledRelease)).toEqual([]);
  expect(releaseDigest(bundledRelease)).toBe('sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd');
  expect(bundledDigest).toBe(releaseDigest(bundledRelease));
});
