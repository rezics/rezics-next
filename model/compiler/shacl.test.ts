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

test('Turtle lowers IRIOrLiteral as a mixed value and keeps incompatible facets refused', async () => {
  const source = turtle(
    'sh:path rv:value ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRIOrLiteral',
  );
  const profile = parseTurtleProfile('probe-v1', source);
  expect(profile.shapes[0]!.properties[0]!.nodeKind).toBe('sh:IRIOrLiteral');
  expect(profileSource(profile)).toBe(source);

  const shape = (await schemas(profile))[profile.shapes[0]!.iri]!;
  expect(Value.Check(shape, node({ 'rv:value': ['urn:resource'] }))).toBe(true);
  expect(Value.Check(shape, node({ 'rv:value': ['plain literal'] }))).toBe(true);
  expect(Value.Check(shape, node({ 'rv:value': [] }))).toBe(false);
  expect(Value.Check(shape, node({ 'rv:value': ['urn:resource', 'plain literal'] }))).toBe(false);
  expect(Value.Check(shape, node({ 'rv:value': 'plain literal' }))).toBe(false);

  const context = JSON.parse(
    buildModelOutputs([profile]).get('generated/model/contexts/probe-v1.jsonld')!,
  ) as { '@context': Record<string, { '@type'?: string }> };
  expect(context['@context']['rv:value']?.['@type']).toBeUndefined();
  expect(() => parseTurtleProfile(
    'probe-v1',
    turtle('sh:path rv:value ; sh:nodeKind sh:IRIOrLiteral ; sh:datatype xsd:string'),
  )).toThrow('Cannot lower sh:nodeKind with sh:datatype');
});

test('Unsupported SHACL and RDF term kinds fail by name rather than losing constraints', () => {
  for (const name of ['or', 'node', 'flags']) {
    expect(() =>
      parseTurtleProfile('probe-v1', turtle(`sh:path rv:value ; sh:${name} rv:Value`)),
    ).toThrow(`sh:${name}`);
  }
  expect(() => parseTurtleProfile('probe-v1', turtle('sh:path (rv:first rv:second)'))).toThrow(
    'sh:path',
  );
  expect(() =>
    parseTurtleProfile('probe-v1', turtle('sh:path rv:value ; sh:hasValue "literal"@en')),
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

test('Turtle patterns and integer bounds preserve the JSON constraints', async () => {
  const text = await schema(
    turtle('sh:path rv:value ; sh:datatype xsd:string ; sh:pattern "^[a-z]+(-[a-z]+)*$"'),
  );
  expect(Value.Check(text, node({ 'rv:value': ['a-b'] }))).toBe(true);
  for (const value of ['A', 'a--b', ''])
    expect(Value.Check(text, node({ 'rv:value': [value] }))).toBe(false);
  const bounded = await schema(
    turtle('sh:path rv:value ; sh:datatype xsd:integer ; sh:minInclusive -2 ; sh:maxInclusive 14'),
  );
  for (const value of [-2, 0, 14])
    expect(Value.Check(bounded, node({ 'rv:value': [value] }))).toBe(true);
  for (const value of [-3, 15, 1.5, '0'])
    expect(Value.Check(bounded, node({ 'rv:value': [value] }))).toBe(false);
  for (const clauses of [
    'sh:datatype xsd:integer ; sh:minInclusive 15 ; sh:maxInclusive 14',
    'sh:datatype xsd:integer ; sh:minInclusive 9007199254740992',
    'sh:datatype xsd:integer ; sh:maxInclusive 1.5',
    'sh:datatype xsd:string ; sh:minInclusive 0',
    'sh:datatype xsd:string ; sh:pattern "["',
    'sh:datatype xsd:integer ; sh:pattern "a"',
  ])
    expect(() => parseTurtleProfile('probe-v1', turtle(`sh:path rv:value ; ${clauses}`))).toThrow();
});

test('Turtle fixed values preserve escaped lexical strings and distinguish IRIs', async () => {
  const lexical = '001\\path\n"雪"';
  const source = turtle(
    `sh:path rv:value ; sh:datatype xsd:string ; sh:maxCount 1 ; sh:hasValue ${JSON.stringify(lexical)}^^xsd:string`,
  );
  const profile = parseTurtleProfile('probe-v1', source);
  expect(profileSource(profile)).toBe(source);
  expect(String(profile.shapes[0]!.properties[0]!.hasValue)).toBe(JSON.stringify(lexical));
  const shape = (await schemas(profile))[profile.shapes[0]!.iri]!;
  expect(Value.Check(shape, node({ 'rv:value': [lexical] }))).toBe(true);
  expect(Value.Check(shape, node({ 'rv:value': ['001'] }))).toBe(false);
  expect(Value.Check(shape, node({}))).toBe(false);
  for (const members of ['"main" "qualifier" "reference"', 'rv:main rv:qualifier']) {
    const enumeration = parseTurtleProfile(
      'probe-v1',
      turtle(`sh:path rv:value ; sh:in (${members})`),
    );
    const typed = (await schemas(enumeration))[enumeration.shapes[0]!.iri]!;
    const literal = members.startsWith('"');
    const context = JSON.parse(
      buildModelOutputs([enumeration]).get('generated/model/contexts/probe-v1.jsonld')!,
    )['@context'];
    expect(context['rv:value']['@type']).toBe(literal ? undefined : '@id');
    expect(
      Value.Check(
        typed,
        node({ 'rv:value': [literal ? 'main' : 'https://rezics.com/vocab/main'] }),
      ),
    ).toBe(true);
    expect(
      Value.Check(
        typed,
        node({ 'rv:value': [literal ? 'https://rezics.com/vocab/main' : 'main'] }),
      ),
    ).toBe(false);
    expect(Value.Check(typed, node({ 'rv:value': ['other'] }))).toBe(false);
  }
  for (const clauses of [
    'sh:in ("main" rv:main)',
    'sh:in ("main"@en)',
    'sh:in ("01"^^xsd:integer)',
    'sh:hasValue "not-integer"^^xsd:integer',
    'sh:hasValue true',
    'sh:datatype xsd:integer ; sh:hasValue "01"',
    'sh:nodeKind sh:IRI ; sh:in ("main")',
    'sh:datatype xsd:string ; sh:in (rv:main)',
    'sh:in ("main") ; sh:pattern "main"',
    'sh:hasValue "main" ; sh:maxLength 4',
    'sh:in ("main") ; sh:hasValue "main"',
    'sh:hasValue "main" ; sh:maxCount 0',
  ])
    expect(() => parseTurtleProfile('probe-v1', turtle(`sh:path rv:value ; ${clauses}`))).toThrow();
});

test('Turtle RDF enums require complete, acyclic, bounded lists with no hidden constructs', () => {
  const withList = (head: string, tail: string) =>
    turtle(`sh:path rv:value ; sh:in ${head}`) + tail;
  for (const [head, tail] of [
    ['rdf:nil', ''],
    ['_:a', '_:a rdf:first "x" .'],
    ['_:a', '_:a rdf:rest rdf:nil .'],
    ['_:a', '_:a rdf:first "x" ; rdf:rest _:a .'],
    ['_:a', '_:a rdf:first "x" ; rdf:rest _:b . _:b rdf:first "y" ; rdf:rest _:a .'],
    ['_:a', '_:a rdf:first "x", "y" ; rdf:rest rdf:nil .'],
    ['_:a', '_:a rdf:first "x" ; rdf:rest rdf:nil, _:b .'],
    ['_:a', '_:a rdf:first "x" ; rdf:rest "tail" .'],
    ['rv:list', ''],
    ['rv:list', 'rv:list rdf:first "x" ; rdf:rest rv:list .'],
    ['_:a', '_:a rdf:first "x" ; rdf:rest rdf:nil ; sh:pattern "ignored" .'],
    ['_:a', '_:a rdf:first [ sh:pattern "ignored" ] ; rdf:rest rdf:nil .'],
    ['("x")', 'rdf:nil rdf:first "hidden" .'],
  ])
    expect(() => parseTurtleProfile('probe-v1', withList(head!, tail!))).toThrow();
  expect(
    parseTurtleProfile(
      'probe-v1',
      withList('rv:list', 'rv:list rdf:first "x" ; rdf:rest rdf:nil .'),
    ).shapes[0]!.properties[0]!.in,
  ).toEqual(['"x"']);
  const items = Array.from({ length: 256 }, (_, index) => `"${index}"`);
  expect(
    parseTurtleProfile('probe-v1', withList(`(${items.join(' ')})`, '')).shapes[0]!.properties[0]!
      .in,
  ).toHaveLength(256);
  expect(() =>
    parseTurtleProfile('probe-v1', withList(`(${[...items, '"overflow"'].join(' ')})`, '')),
  ).toThrow('exceeds 256');
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

test('Turtle fixed integer literals map exactly to safe JSON numbers with authored bytes intact', async () => {
  for (const datatype of ['', '; sh:datatype xsd:integer']) {
    const source = turtle(
      `sh:path rv:value ; sh:maxCount 1 ; sh:hasValue "+0001"^^xsd:integer ${datatype}`,
    );
    const profile = parseTurtleProfile('probe-v1', source);
    expect(profileSource(profile)).toBe(source);
    expect(profile.shapes[0]!.properties[0]!.hasValue).toBe('1');
    const shape = (await schemas(profile))[profile.shapes[0]!.iri]!;
    expect(Value.Check(shape, node({ 'rv:value': [1] }))).toBe(true);
    for (const value of ['1', '+0001', 0, 1.5, null])
      expect(Value.Check(shape, node({ 'rv:value': [value] }))).toBe(false);
    const context = JSON.parse(
      buildModelOutputs([profile]).get('generated/model/contexts/probe-v1.jsonld')!,
    )['@context'];
    expect(context['rv:value']['@type']).toBe('xsd:integer');
  }
  for (const clauses of [
    'sh:hasValue 9007199254740992',
    'sh:hasValue "1.0"^^xsd:integer',
    'sh:hasValue 1.0',
    'sh:datatype xsd:string ; sh:hasValue 1',
    'sh:nodeKind sh:IRI ; sh:hasValue 1',
    'sh:datatype xsd:integer ; sh:hasValue 1 ; sh:minInclusive 0',
    'sh:in (1 2)',
  ])
    expect(() => parseTurtleProfile('probe-v1', turtle(`sh:path rv:value ; ${clauses}`))).toThrow();
});

test('Turtle language lists keep the existing exact language-value JSON mapping', async () => {
  const shape = await schema(
    turtle(
      'sh:path rv:value ; sh:datatype rdf:langString ; sh:languageIn ("en") ; sh:minLength 3 ; sh:maxLength 120',
    ),
  );
  expect(
    Value.Check(shape, node({ 'rv:value': [{ '@value': 'Question', '@language': 'en' }] })),
  ).toBe(true);
  for (const value of [
    'Question',
    { '@value': 'Question', '@language': 'fr' },
    { '@value': 'Question', '@language': 'en-US' },
    { '@value': 'No', '@language': 'en' },
    { '@value': 'x'.repeat(121), '@language': 'en' },
    { '@value': 'Question' },
    null,
  ])
    expect(Value.Check(shape, node({ 'rv:value': [value] }))).toBe(false);
  for (const clauses of [
    'sh:datatype xsd:string ; sh:languageIn ("en")',
    'sh:datatype rdf:langString ; sh:languageIn ()',
    'sh:datatype rdf:langString ; sh:languageIn (rv:English)',
    'sh:datatype rdf:langString ; sh:languageIn ("en"@en)',
    'sh:datatype rdf:langString ; sh:languageIn (1)',
  ])
    expect(() => parseTurtleProfile('probe-v1', turtle(`sh:path rv:value ; ${clauses}`))).toThrow();
  const languageList = (tail: string) =>
    turtle('sh:path rv:value ; sh:datatype rdf:langString ; sh:languageIn _:languages') + tail;
  for (const tail of [
    '_:languages rdf:first "en" ; rdf:rest _:languages .',
    '_:languages rdf:first "en" .',
    '_:languages rdf:first "en" ; rdf:rest rdf:nil ; sh:pattern "hidden" .',
  ])
    expect(() => parseTurtleProfile('probe-v1', languageList(tail))).toThrow();
  expect(() =>
    parseTurtleProfile(
      'probe-v1',
      turtle(
        `sh:path rv:value ; sh:datatype rdf:langString ; sh:languageIn (${Array(257).fill('"en"').join(' ')})`,
      ),
    ),
  ).toThrow('exceeds 256');
});

const availabilityBranches = `(
  [ sh:property [ sh:path rv:availability ; sh:hasValue rv:Available ] ;
    sh:property [ sh:path rv:value ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:integer ; sh:minInclusive 1 ; sh:maxInclusive 10 ] ]
  [ sh:property [ sh:path rv:availability ; sh:hasValue rv:Withdrawn ] ;
    sh:property [ sh:path rv:value ; sh:maxCount 0 ] ]
)`;
const disjunction = (branches: string) =>
  turtle(
    'sh:path rv:availability ; sh:minCount 1 ; sh:maxCount 1 ; sh:in (rv:Available rv:Withdrawn)',
    `sh:or ${branches} ;`,
  );

test('Turtle local disjunctions preserve available and withdrawn rating counterexamples', async () => {
  const shape = await schema(disjunction(availabilityBranches));
  const available = { 'rv:availability': ['https://rezics.com/vocab/Available'] };
  const withdrawn = { 'rv:availability': ['https://rezics.com/vocab/Withdrawn'] };
  for (const value of [1, 10])
    expect(Value.Check(shape, node({ ...available, 'rv:value': [value] }))).toBe(true);
  expect(Value.Check(shape, node(withdrawn))).toBe(true);
  expect(Value.Check(shape, node({ ...withdrawn, 'rv:value': [] }))).toBe(true);
  for (const values of [[], [0], [11], [1.5], ['1'], [null], [1, 2]])
    expect(Value.Check(shape, node({ ...available, 'rv:value': values }))).toBe(false);
  expect(Value.Check(shape, node(available))).toBe(false);
  expect(Value.Check(shape, node({ ...withdrawn, 'rv:value': [1] }))).toBe(false);
  expect(Value.Check(shape, node({ ...withdrawn, 'rv:value': null }))).toBe(false);
  expect(Value.Check(shape, node({ 'rv:availability': ['Available'], 'rv:value': [1] }))).toBe(
    false,
  );
});

test('Turtle local disjunctions reject malformed lists, nesting and unlowerable groups', () => {
  for (const branches of [
    '()',
    '([ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
    '("literal" [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
    '([] [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
    '([ sh:class rv:Rating ] [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
    '([ sh:or () ] [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
    '([ sh:property [ sh:path (rv:first rv:second) ] ] [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
    '([ sh:property [ sh:path rv:value ; sh:datatype xsd:decimal ] ] [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ])',
  ])
    expect(() => parseTurtleProfile('probe-v1', disjunction(branches))).toThrow();
  for (const tail of [
    '_:groups rdf:first [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ] ; rdf:rest _:groups .',
    '_:groups rdf:first [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ] .',
    '_:groups rdf:first [ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ] ; rdf:rest "bad" .',
  ])
    expect(() => parseTurtleProfile('probe-v1', disjunction('_:groups') + tail)).toThrow();
  const group = '[ sh:property [ sh:path rv:value ; sh:maxCount 0 ] ]';
  expect(() =>
    parseTurtleProfile('probe-v1', disjunction(`(${Array(257).fill(group).join(' ')})`)),
  ).toThrow('exceeds 256');
  const properties = Array.from(
    { length: 257 },
    (_, index) => `sh:property [ sh:path rv:value${index} ; sh:maxCount 0 ]`,
  ).join(' ; ');
  expect(() => parseTurtleProfile('probe-v1', disjunction(`([ ${properties} ] ${group})`))).toThrow(
    '1 to 256 properties',
  );
});
