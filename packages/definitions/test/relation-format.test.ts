import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease, valueSchema, type Release } from '../src/index.ts';

const root = `id: https://rezics.com/catalogue/relation-test
name: relation test
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wdt: http://www.wikidata.org/prop/direct/
imports:
  - linkml:types
  - relations
`;

const relations = `id: https://rezics.com/catalogue/relations
name: relations
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wdt: http://www.wikidata.org/prop/direct/
default_range: string
imports:
  - linkml:types
classes:
  Thing:
    abstract: true
  Root:
    is_a: Thing
    class_uri: schema:Root
    annotations:
      cover_ratio: 2:3
  Middle:
    is_a: Root
    class_uri: schema:Middle
    annotations:
      cover_ratio: 3:4
  Leaf:
    is_a: Middle
    class_uri: schema:Leaf
    slots:
      - related
  OtherRoot:
    is_a: Thing
    abstract: true
    class_uri: schema:OtherRoot
    annotations:
      cover_ratio: 4:3
  Intermediate:
    is_a: OtherRoot
    class_uri: schema:Intermediate
  Deep:
    is_a: Intermediate
    class_uri: schema:Deep
  Person:
    is_a: Thing
    class_uri: schema:Person
slots:
  related:
    slot_uri: schema:related
    range: Person
    annotations:
      datatype: wikibase-item
      qualifiers: position role
  position:
    slot_uri: schema:position
    pattern: '^[1-9][0-9]{0,2}$'
    annotations:
      datatype: string
  role:
    slot_uri: schema:role
    range: Person
    annotations:
      datatype: wikibase-item
  title:
    slot_uri: schema:title
    annotations:
      datatype: string
  reverse:
    slot_uri: wdt:P156
    range: Person
    annotations:
      datatype: wikibase-item
`;

const english = {
  types: {
    'schema:Root': 'root',
    'schema:Middle': 'middle',
    'schema:Leaf': 'leaf',
    'schema:Intermediate': 'intermediate',
    'schema:Deep': 'deep',
    'schema:Person': 'person',
  },
  properties: {
    'schema:related': 'related item',
    'schema:position': 'position',
    'schema:role': 'role',
    'schema:title': 'title',
    'wdt:P156': 'reverse item',
  },
};

const presentation = (inverse?: string) => ({
  'relations/en': Bun.YAML.stringify({
    ...english,
    ...(inverse === undefined ? {} : { inverseProperties: { 'schema:related': inverse } }),
  }),
  ...(inverse === undefined ? {} : { 'relations/ja': 'inverseProperties:\n  schema:related: 関連される\n' }),
});

const input = (schema = relations, inverse?: string) => ({
  root: 'fixture.yaml',
  schemas: { 'fixture.yaml': root, 'relations.yaml': schema },
  presentation: presentation(inverse) as Record<string, string>,
});

const directedAnnotations = `      relation_group: order
      inverse: wdt:P157
      acyclic: true
      relation_order: position
      relation_filter: schema:role`;
const withAnnotations = (annotations: string) =>
  relations.replace('      qualifiers: position role', `      qualifiers: position role\n${annotations}`);
const violationPointers = (error: unknown) => {
  expect(error).toBeInstanceOf(CatalogueError);
  return (error as CatalogueError).violations.map(({ file, pointer }) => `${file} ${pointer}`);
};
const expectCompilePointer = async (source: string, file: string, pointer: string, inverse?: string) => {
  const error = await compileCatalogue(input(source, inverse)).catch((caught: unknown) => caught);
  expect(violationPointers(error)).toContain(`${file} ${pointer}`);
};

test('an item property compiles its relation direction, inverse labels, group, acyclicity, order and filter', async () => {
  const release = await compileCatalogue(input(withAnnotations(directedAnnotations), 'related from'));
  expect(release.properties['schema:related']!.relation).toEqual({
    group: 'order',
    inverse: 'wdt:P157',
    inverseLabels: { en: 'related from', ja: '関連される' },
    acyclic: true,
    order: 'position',
    filter: 'schema:role',
  });
  expect(release.properties['schema:related']!.labels.en).toBe('related item');

  const symmetric = await compileCatalogue(
    input(withAnnotations('      relation_group: world\n      symmetric: true'), undefined),
  );
  expect(symmetric.properties['schema:related']!.relation).toEqual({
    group: 'world',
    symmetric: true,
    order: 'name',
  });
  expect(symmetric.properties['schema:related']!.relation!.inverseLabels).toBeUndefined();

  const holderOnly = await compileCatalogue(
    input(withAnnotations('      relation_group: association\n      inverse: none')),
  );
  expect(holderOnly.properties['schema:related']!.relation).toEqual({
    group: 'association',
    inverse: 'none',
    order: 'name',
  });
});

test('inconsistent relation declarations are refused with precise errors', async () => {
  await expectCompilePointer(
    withAnnotations('      relation_group: unsupported\n      inverse: wdt:P157'),
    'relations.yaml',
    '/slots/related/annotations/relation_group',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      inverse: wdt:P157\n      symmetric: true'),
    'relations.yaml',
    '/slots/related/annotations/symmetric',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order'),
    'relations.yaml',
    '/slots/related/annotations/relation_group',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      inverse: wdt:P156'),
    'relations.yaml',
    '/slots/related/annotations/inverse',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      inverse: wdt:P157'),
    'presentation/relations/en',
    '/inverseProperties/schema:related',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: world\n      symmetric: true'),
    'presentation/relations/en',
    '/inverseProperties/schema:related',
    'invalid reverse label',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: association\n      inverse: none'),
    'presentation/relations/en',
    '/inverseProperties/schema:related',
    'invalid holder-only label',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      symmetric: true\n      acyclic: true'),
    'relations.yaml',
    '/slots/related/annotations/acyclic',
  );
  await expectCompilePointer(
    relations.replace(
      '  title:\n    slot_uri: schema:title\n    annotations:\n      datatype: string',
      '  title:\n    slot_uri: schema:title\n    annotations:\n      datatype: string\n      relation_group: order\n      inverse: wdt:P157',
    ),
    'relations.yaml',
    '/slots/title/annotations/relation_group',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      inverse: wdt:P157\n      relation_order: position').replace(
      '      qualifiers: position role\n      relation_group:',
      '      qualifiers: role\n      relation_group:',
    ),
    'relations.yaml',
    '/slots/related/annotations/relation_order',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      inverse: wdt:P157\n      relation_filter: schema:position'),
    'relations.yaml',
    '/slots/related/annotations/relation_filter',
  );
  await expectCompilePointer(
    withAnnotations('      relation_group: order\n      inverse: wdt:P157\n      relation_filter: wdt:P999'),
    'relations.yaml',
    '/slots/related/annotations/relation_filter',
  );
  const misplaced = input(withAnnotations('      relation_group: order\n      inverse: wdt:P157'));
  misplaced.presentation = {
    'other/en': Bun.YAML.stringify({
      ...english,
      inverseProperties: { 'schema:related': 'wrong home' },
    }),
  };
  const misplacedError = await compileCatalogue(misplaced).catch((caught: unknown) => caught);
  expect(violationPointers(misplacedError)).toContain('presentation/other/en /inverseProperties/schema:related');
  await expectCompilePointer(
    relations.replace('      cover_ratio: 2:3', '      cover_ratio: 0:3'),
    'relations.yaml',
    '/classes/Root/annotations/cover_ratio',
  );

  const valid = await compileCatalogue(input(withAnnotations(directedAnnotations), 'related from'));
  const validatePointer = (change: (release: any) => void, pointer: string) => {
    const candidate = structuredClone(valid) as any;
    change(candidate);
    expect(validateRelease(candidate).map(({ pointer: actual }) => actual)).toContain(pointer);
  };
  validatePointer(
    (draft) => (draft.properties['schema:related'].relation.group = 'unknown'),
    '/properties/schema:related/relation/group',
  );
  validatePointer(
    (draft) => delete draft.properties['schema:related'].relation.inverse,
    '/properties/schema:related/relation',
  );
  validatePointer(
    (draft) => (draft.properties['schema:related'].relation.symmetric = true),
    '/properties/schema:related/relation',
  );
  validatePointer(
    (draft) => (draft.properties['schema:related'].relation.inverse = 'wdt:P156'),
    '/properties/schema:related/relation/inverse',
  );
  validatePointer(
    (draft) => delete draft.properties['schema:related'].relation.inverseLabels,
    '/properties/schema:related/relation/inverseLabels',
  );
  validatePointer(
    (draft) => (draft.properties['schema:related'].relation.inverseLabels = { en: 'inverse', 'bad tag': 'bad' }),
    '/properties/schema:related/relation/inverseLabels/bad tag',
  );
  validatePointer((draft) => {
    delete draft.properties['schema:related'].relation.inverse;
    draft.properties['schema:related'].relation.symmetric = true;
  }, '/properties/schema:related/relation/inverseLabels');
  validatePointer((draft) => {
    delete draft.properties['schema:related'].relation.inverse;
    draft.properties['schema:related'].relation.symmetric = true;
    draft.properties['schema:related'].relation.acyclic = true;
  }, '/properties/schema:related/relation/acyclic');
  validatePointer((draft) => {
    const property = draft.properties['schema:related'];
    property.datatype = 'string';
    delete property.targets;
    property.value = valueSchema('string');
  }, '/properties/schema:related/relation');
  validatePointer((draft) => {
    draft.properties['schema:related'].qualifiers = ['schema:role'];
    draft.properties['schema:related'].relation.order = 'position';
  }, '/properties/schema:related/relation/order');
  validatePointer(
    (draft) => (draft.properties['schema:related'].relation.filter = 'schema:position'),
    '/properties/schema:related/relation/filter',
  );
  validatePointer((draft) => (draft.types['schema:Deep'].coverRatio = '0:1'), '/types/schema:Deep/coverRatio');
});

test("a type's cover ratio is its own annotation or its nearest base's", async () => {
  const release = await compileCatalogue(input());
  expect(release.types['schema:Root']!.coverRatio).toBe('2:3');
  expect(release.types['schema:Middle']!.coverRatio).toBe('3:4');
  expect(release.types['schema:Leaf']!.coverRatio).toBe('3:4');
  expect(release.types['schema:Intermediate']!.coverRatio).toBe('4:3');
  expect(release.types['schema:Deep']!.coverRatio).toBe('4:3');
  expect(release.types['schema:Person']!.coverRatio).toBeUndefined();

  const invalid = structuredClone(release) as Release & { types: Record<string, any> };
  invalid.types['schema:Deep']!.coverRatio = '65:1';
  expect(validateRelease(invalid).map(({ pointer }) => pointer)).toContain('/types/schema:Deep/coverRatio');
});

test('a relation slot key compiles as an admitted item qualifier and is bundled for voice credits', async () => {
  const release = await compileCatalogue(
    input(withAnnotations(`${directedAnnotations}\n      relation_slot_key: schema:role`), 'related from'),
  );
  expect(release.properties['schema:related']!.relation).toEqual({
    group: 'order',
    inverse: 'wdt:P157',
    inverseLabels: { en: 'related from', ja: '関連される' },
    acyclic: true,
    order: 'position',
    filter: 'schema:role',
    slotKey: 'schema:role',
  });
  expect(validateRelease(release)).toEqual([]);
  expect(bundledRelease.properties['wdt:P725']!.relation!.slotKey).toBe('wdt:P453');
});

test('slot keys refuse unknown, unadmitted and non-item qualifiers at compilation and release validation', async () => {
  for (const key of ['wdt:P999', 'wdt:P156', 'schema:position']) {
    await expectCompilePointer(
      withAnnotations(`${directedAnnotations}\n      relation_slot_key: ${key}`),
      'relations.yaml',
      '/slots/related/annotations/relation_slot_key',
      'related from',
    );
  }
  const release = await compileCatalogue(input(withAnnotations(directedAnnotations), 'related from'));
  for (const slotKey of ['wdt:P999', 'wdt:P156', 'schema:position']) {
    const changed = structuredClone(release);
    changed.properties['schema:related']!.relation!.slotKey = slotKey;
    expect(validateRelease(changed)).toContainEqual({
      pointer: '/properties/schema:related/relation/slotKey',
      code: 'invalid',
    });
  }
  const malformed = structuredClone(release) as any;
  malformed.properties['schema:related'].relation.slotKey = 1;
  expect(validateRelease(malformed)).not.toEqual([]);
});

test('a relation filter admits two qualifiers and refuses oversized or non-item lists', async () => {
  const source = withAnnotations(directedAnnotations.replace('schema:role', '[schema:role, wdt:P156]')).replace(
    'qualifiers: position role',
    'qualifiers: position role reverse related',
  );
  const release = await compileCatalogue(input(source, 'related from'));
  expect(release.properties['schema:related']!.relation!.filter).toEqual(['schema:role', 'wdt:P156']);
  expect(validateRelease(release)).toEqual([]);
  for (const filter of [
    ['schema:role', 'wdt:P156', 'schema:related'],
    ['schema:role', 'schema:position'],
    ['schema:role', 'schema:title'],
    ['schema:role', 'schema:role'],
    [],
  ]) {
    await expectCompilePointer(
      source.replace('[schema:role, wdt:P156]', JSON.stringify(filter)),
      'relations.yaml',
      '/slots/related/annotations/relation_filter',
      'related from',
    );
    const changed = structuredClone(release);
    changed.properties['schema:related']!.relation!.filter = filter;
    expect(validateRelease(changed).length).toBeGreaterThan(0);
  }
});
