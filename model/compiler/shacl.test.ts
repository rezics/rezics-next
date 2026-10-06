import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import { buildModelOutputs } from './outputs.ts';
import { parseTurtleProfile, profileSource } from './shacl.ts';
import { discoverProfiles, commandProfiles } from './generate.ts';
import type { ProfileDefinition } from './ir.ts';

const root = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const prefix = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rv: <https://rezics.com/vocab/> .
@prefix schema: <https://schema.org/> .
`;
const turtle = (properties: string, extra = '') => `${prefix}
<https://rezics.com/definition/probe-v1/item-shape> a sh:NodeShape ;
${extra} sh:property [ ${properties} ] .\n`;
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/turtle-model-'));
  temporary.push(path);
  return path;
}
async function schemas(profile: ProfileDefinition): Promise<Record<string, TSchema>> {
  const path = join(directory(), 'schemas.ts');
  writeFileSync(path, buildModelOutputs([profile]).get('packages/model/src/generated/schemas.ts')!);
  return ((await import(path)) as { shapeSchemas: Record<string, TSchema> }).shapeSchemas;
}
async function schema(source: string): Promise<TSchema> {
  const profile = parseTurtleProfile('probe-v1', source);
  return (await schemas(profile))[profile.shapes[0]!.iri]!;
}
const node = (values: Record<string, unknown>) => ({ '@id': 'urn:probe:node', ...values });

test('Turtle discovery preserves authored bytes and refuses duplicate IDs across source languages', () => {
  const source = turtle('sh:path rv:head ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  const path = directory();
  writeFileSync(join(path, 'probe-v1.ttl'), source);
  const declaration = { id: 'probe-v1', canonical: { item: { types: ['rv:Post' as const] } } };
  const profiles = discoverProfiles(path, [['probe-v1.ts', { probeDeclaration: declaration }]]);
  expect(profileSource(profiles[0]!)).toBe(source);
  const command = commandProfiles(profiles, {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  expect(command.shapes.get('shapes/probe-v1.ttl')).toBe(source);
  expect(command.profiles[0]!.shapes).toEqual([
    'https://rezics.com/definition/probe-v1/item-shape',
  ]);
  expect(() => discoverProfiles(path, [['probe-v1.ts', { probeProfile: profiles[0] }]])).toThrow(
    'Duplicate profile ID probe-v1',
  );
  expect(() =>
    discoverProfiles(path, [
      [
        'probe-v1.ts',
        { probeDeclaration: { ...declaration, canonical: { missing: { types: ['rv:Post'] } } } },
      ],
    ]),
  ).toThrow('unknown canonical role missing');
});

test('Turtle cardinalities count distinct values, including zero and required IRI hasValue', async () => {
  const source = turtle('sh:path rdf:type ; sh:minCount 2 ; sh:maxCount 2 ; sh:hasValue rv:Post');
  const shape = await schema(source);
  const post = 'https://rezics.com/vocab/Post';
  expect(Value.Check(shape, node({ 'rdf:type': [post, 'https://schema.org/CreativeWork'] }))).toBe(
    true,
  );
  expect(Value.Check(shape, node({ 'rdf:type': [post, post] }))).toBe(false);
  expect(Value.Check(shape, node({ 'rdf:type': [post] }))).toBe(false);
  expect(
    Value.Check(
      shape,
      node({ 'rdf:type': ['https://schema.org/CreativeWork', 'https://schema.org/Book'] }),
    ),
  ).toBe(false);
  const zero = await schema(turtle('sh:path rv:head ; sh:minCount 0 ; sh:maxCount 0'));
  expect(Value.Check(zero, node({}))).toBe(true);
  expect(Value.Check(zero, node({ 'rv:head': [] }))).toBe(true);
  expect(Value.Check(zero, node({ 'rv:head': ['urn:value'] }))).toBe(false);
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:head ; sh:minCount 2 ; sh:maxCount 1')),
  ).toThrow('minCount exceeds maxCount');
});

test('Turtle optional boolean distinguishes omission, false, true, null and wrong lexical values', async () => {
  const shape = await schema(
    turtle('sh:path rv:spoiler ; sh:maxCount 1 ; sh:datatype xsd:boolean'),
  );
  for (const value of [
    {},
    { 'rv:spoiler': [] },
    { 'rv:spoiler': [false] },
    { 'rv:spoiler': [true] },
  ]) {
    expect(Value.Check(shape, node(value))).toBe(true);
  }
  for (const value of [null, ['true'], [0], [true, false]])
    expect(Value.Check(shape, node({ 'rv:spoiler': value }))).toBe(false);
});

test('Turtle language strings enforce lengths and case-insensitive uniqueLang', async () => {
  const shape = await schema(
    turtle(
      'sh:path schema:name ; sh:minCount 1 ; sh:datatype rdf:langString ; sh:uniqueLang true ; sh:minLength 1 ; sh:maxLength 4',
    ),
  );
  const title = (value: string, language: string) => ({ '@value': value, '@language': language });
  expect(
    Value.Check(shape, node({ 'schema:name': [title('雨夜', 'zh-Hant'), title('Rain', 'en')] })),
  ).toBe(true);
  for (const values of [
    [title('A', 'en-US'), title('B', 'en-us')],
    [title('', 'en')],
    [title('Longer', 'en')],
    ['Literal'],
    [{ '@value': 'No tag' }],
  ])
    expect(Value.Check(shape, node({ 'schema:name': values }))).toBe(false);
  const unrestricted = await schema(
    turtle('sh:path schema:name ; sh:datatype rdf:langString ; sh:uniqueLang false'),
  );
  expect(
    Value.Check(unrestricted, node({ 'schema:name': [title('A', 'en'), title('B', 'en')] })),
  ).toBe(true);
});

test('Turtle supports IRI node kind, class, closed shapes and the explicit datatype mappings', async () => {
  const profile = parseTurtleProfile(
    'probe-v1',
    turtle(
      'sh:path rv:work ; sh:nodeKind sh:IRI ; sh:class schema:CreativeWork',
      'sh:closed true ;',
    ),
  );
  expect(profile.shapes[0]!.properties[0]!.class).toBe('schema:CreativeWork');
  expect(profile.shapes[0]!.properties[0]!.nodeKind).toBe('sh:IRI');
  const shape = (await schemas(profile))[profile.shapes[0]!.iri]!;
  expect(Value.Check(shape, node({ 'rv:work': ['urn:work'] }))).toBe(true);
  expect(Value.Check(shape, node({ extra: ['urn:value'] }))).toBe(false);
  for (const [datatype, valid, invalid] of [
    ['string', 'text', 1],
    ['integer', 2, 1.5],
    ['dateTime', '2026-10-07T00:00:00Z', 'today'],
  ] as const) {
    const typed = await schema(turtle(`sh:path rv:value ; sh:datatype xsd:${datatype}`));
    expect(Value.Check(typed, node({ 'rv:value': [valid] }))).toBe(true);
    expect(Value.Check(typed, node({ 'rv:value': [invalid] }))).toBe(false);
  }
});

test('Unsupported SHACL and RDF term kinds fail by name rather than losing constraints', () => {
  for (const name of ['pattern', 'in', 'or', 'node', 'minInclusive', 'languageIn']) {
    expect(() =>
      parseTurtleProfile('probe-v1', turtle(`sh:path rv:value ; sh:${name} rv:Value`)),
    ).toThrow(`sh:${name}`);
  }
  expect(() => parseTurtleProfile('probe-v1', turtle('sh:path (rv:first rv:second)'))).toThrow(
    'sh:path',
  );
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:value ; sh:hasValue "literal"')),
  ).toThrow('sh:hasValue');
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:value ; sh:nodeKind sh:Literal')),
  ).toThrow('sh:nodeKind');
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:value ; sh:datatype xsd:decimal')),
  ).toThrow('sh:datatype');
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:value ; sh:maxCount "1"')),
  ).toThrow('sh:maxCount');
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:value', 'sh:targetClass rv:Post ;')),
  ).toThrow('sh:targetClass');
  expect(() =>
    parseTurtleProfile(
      'probe-v1',
      turtle('sh:path rv:value') + 'rv:Unreachable sh:pattern "ignored" .',
    ),
  ).toThrow('sh:pattern');
});

test('The DSL lowerer preserves literal enum term kinds in every generated context', async () => {
  const profile = parseTurtleProfile(
    'probe-v1',
    turtle('sh:path rv:value ; sh:datatype xsd:string'),
  );
  const literal = {
    ...profile,
    shapes: [
      {
        ...profile.shapes[0]!,
        properties: [
          {
            path: 'rv:value' as const,
            minCount: 1,
            maxCount: 1,
            in: ['"download"', '"source"'] as const,
          },
        ],
      },
    ],
  };
  const outputs = buildModelOutputs([literal]);
  const context = JSON.parse(outputs.get('generated/model/contexts/probe-v1.jsonld')!)['@context'];
  expect(context['rv:value']).toEqual({ '@id': 'https://rezics.com/vocab/value' });
  const shape = (await schemas(literal))[literal.shapes[0]!.iri]!;
  expect(Value.Check(shape, node({ 'rv:value': ['download'] }))).toBe(true);
  expect(Value.Check(shape, node({ 'rv:value': ['https://rezics.com/vocab/download'] }))).toBe(
    false,
  );
  const release = readFileSync(join(root, 'generated/model/contexts/release-v3.jsonld'), 'utf8');
  expect(JSON.parse(release)['@context']['rv:releaseKind']['@type']).toBeUndefined();
});

test('The DSL lowerer distinguishes single fixed literals from single fixed IRIs', async () => {
  for (const hasValue of ['"download"', 'rv:download'] as const) {
    const profile = parseTurtleProfile(
      'probe-v1',
      turtle('sh:path rv:value ; sh:datatype xsd:string'),
    );
    const fixed = {
      ...profile,
      shapes: [
        {
          ...profile.shapes[0]!,
          properties: [{ path: 'rv:value' as const, hasValue, maxCount: 1 }],
        },
      ],
    };
    const context = JSON.parse(
      buildModelOutputs([fixed]).get('generated/model/contexts/probe-v1.jsonld')!,
    )['@context'];
    const literal = hasValue.startsWith('"');
    expect(context['rv:value']['@type']).toBe(literal ? undefined : '@id');
    const shape = (await schemas(fixed))[fixed.shapes[0]!.iri]!;
    expect(
      Value.Check(
        shape,
        node({ 'rv:value': [literal ? 'download' : 'https://rezics.com/vocab/download'] }),
      ),
    ).toBe(true);
    expect(
      Value.Check(
        shape,
        node({ 'rv:value': [literal ? 'https://rezics.com/vocab/download' : 'download'] }),
      ),
    ).toBe(false);
  }
});
