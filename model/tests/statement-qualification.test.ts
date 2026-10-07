import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { statementDeclaration } from '../definitions/statement-v1.ts';

const root = resolve(import.meta.dir, '../..');
const definition = 'https://rezics.com/definition/statement-v1';
const rv = 'https://rezics.com/vocab/';
const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const source = readFileSync(join(root, 'model/definitions/statement-v1.ttl'), 'utf8');
const profile = parseTurtleProfile('statement-v1', source, statementDeclaration);
const statement = profile.shapes.find((shape) => shape.iri === `${definition}/statement-shape`)!;
const revision = profile.shapes.find((shape) => shape.iri === `${definition}/revision-shape`)!;
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
let schemasPromise: Promise<Record<string, TSchema>> | undefined;
function schemas(): Promise<Record<string, TSchema>> {
  if (!schemasPromise) {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const directory = mkdtempSync(join(root, '.temp/statement-qualification-'));
    temporary.push(directory);
    const path = join(directory, 'schemas.ts');
    writeFileSync(
      path,
      buildModelOutputs([profile]).get('packages/model/src/generated/schemas.ts')!,
    );
    schemasPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemasPromise;
}
async function accepts(values: Record<string, unknown>): Promise<boolean> {
  return Value.Check((await schemas())[statement.iri]!, values);
}
const unqualified = () => ({
  '@id': 'urn:statement:independent',
  'rdf:type': [`${rdf}Statement`],
  'rdf:subject': ['urn:statement:subject'],
  'rdf:predicate': ['https://schema.org/datePublished'],
  'rdf:object': [{ '@value': '0001-01-01', '@type': 'http://www.w3.org/2001/XMLSchema#date' }],
  'rv:relationDefinition': ['urn:definition:date-published-revision'],
  'rv:speaker': ['urn:speaker:author'],
  'rv:meaningKey': ['urn:meaning:unchanged'],
  'rv:statementState': [`${rv}Active`],
  'rv:head': ['urn:statement:revision'],
});
const qualification = () => ({
  'rv:qualificationDefinition': ['urn:definition:qualification-revision'],
  'rv:interpretationContext': ['urn:interpretation:scope'],
  'rv:valuePrecision': [`${rv}ExactValue`],
});
const optional = () => ({
  'rv:valueQualifier': [`${rv}DisputedAttribution`, `${rv}InferredValue`],
  'rv:validFrom': ['0001-01-01T00:00:00Z'],
  'rv:validUntil': ['2026-10-07T08:00:00+08:00'],
  'rv:editionScope': ['urn:edition:exact'],
});

// These are the complete constraints before converting the authoring language.
// New qualification constraints must not change historical unqualified admission.
const originalStatement = [
  { path: 'rdf:type', hasValue: 'rdf:Statement' },
  { path: 'rdf:subject', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rdf:predicate', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rdf:object', minCount: 1, maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
  { path: 'rv:relationDefinition', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:interpretationDefinition', maxCount: 8, nodeKind: 'sh:IRI' },
  { path: 'rv:semanticContextRevision', maxCount: 1, class: 'rv:ContextSemanticRevision' },
  { path: 'rv:speaker', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:applicability', maxCount: 8, nodeKind: 'sh:IRI' },
  { path: 'rv:meaningKey', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:statementState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Withdrawn'] },
  { path: 'rv:head', minCount: 1, maxCount: 1, class: 'rv:StatementRevision' },
  { path: 'rv:source', maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:migratedFrom', maxCount: 1, class: 'rv:ClassificationApplication' },
  { path: 'rv:principal', maxCount: 0 },
];
const originalRevision = [
  { path: 'rdf:type', in: ['rv:StatementRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
  { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rdf:Statement' },
  { path: 'rv:predecessor', maxCount: 1, class: 'rv:StatementRevision' },
  { path: 'rv:statementState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Withdrawn'] },
  { path: 'rv:evidence', maxCount: 16, nodeKind: 'sh:IRI' },
  { path: 'rv:recordedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:modelRevision', hasValue: `<${definition}>`, maxCount: 1 },
  { path: 'rv:shapeRevision', hasValue: `<${definition}>`, maxCount: 1 },
  { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
];

test('authored Statement Turtle retains old constraints and canonical routes exactly', () => {
  const oldPaths = new Set(originalStatement.map((property) => property.path));
  expect(statement.properties.filter((property) => oldPaths.has(property.path))).toEqual(
    originalStatement,
  );
  expect(revision.properties).toEqual(originalRevision);
  expect(statement.canonical).toEqual({ types: ['rdf:Statement'] });
  expect(revision.canonical).toEqual({ types: ['rv:StatementRevision'] });
  expect(revision.or).toBeUndefined();
  expect(
    discoverProfiles(join(root, 'model/definitions'), [
      ['statement-v1.ts', { statementDeclaration }],
    ]).find((item) => item.id === 'statement-v1'),
  ).toEqual(profile);
  const command = commandProfiles([profile], {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  expect(command.shapes.get('shapes/statement-v1.ttl')).toBe(source);
  expect(profileSource(profile)).toBe(source);
  expect(command.manifest.canonical).toEqual([
    {
      type: `${rdf}Statement`,
      routes: [{ profile: 'statement-v1', shape: statement.iri, when: [] }],
    },
    {
      type: `${rv}StatementRevision`,
      routes: [{ profile: 'statement-v1', shape: revision.iri, when: [] }],
    },
  ]);
});

test('old unqualified Statements and exact RDF object envelopes remain admitted', async () => {
  expect(await accepts(unqualified())).toBe(true);
  for (const object of [
    'urn:object:exact',
    { '@value': '01.00', '@type': 'http://www.w3.org/2001/XMLSchema#decimal' },
    { '@value': '雨\nquoted "text"', '@language': 'zh-Hant' },
  ]) {
    expect(await accepts({ ...unqualified(), 'rdf:object': [object] })).toBe(true);
    expect(await accepts({ ...unqualified(), ...qualification(), 'rdf:object': [object] })).toBe(
      true,
    );
  }
  expect(await accepts({ ...unqualified(), 'rv:statementState': [`${rv}Withdrawn`] })).toBe(true);
  expect(await accepts({ ...unqualified(), 'rv:principal': ['urn:principal:wrong'] })).toBe(false);
  expect(await accepts({ ...unqualified(), 'rdf:object': [] })).toBe(false);
});

test('qualification is one fixed bundle with a required pin, scope and precision', async () => {
  expect(await accepts({ ...unqualified(), ...qualification() })).toBe(true);
  expect(await accepts({ ...unqualified(), ...qualification(), ...optional() })).toBe(true);
  for (const [path, value] of Object.entries({ ...qualification(), ...optional() })) {
    expect(await accepts({ ...unqualified(), [path]: value })).toBe(false);
  }
  for (const path of Object.keys(qualification())) {
    const incomplete: Record<string, unknown> = { ...qualification() };
    delete incomplete[path];
    expect(await accepts({ ...unqualified(), ...incomplete })).toBe(false);
    expect(await accepts({ ...unqualified(), ...qualification(), [path]: [] })).toBe(false);
    expect(await accepts({ ...unqualified(), ...qualification(), [path]: null })).toBe(false);
  }
  for (const precision of ['ExactValue', 'ApproximateValue', 'UncertainValue']) {
    expect(
      await accepts({
        ...unqualified(),
        ...qualification(),
        'rv:valuePrecision': [`${rv}${precision}`],
      }),
    ).toBe(true);
  }
  expect(
    await accepts({ ...unqualified(), ...qualification(), 'rv:valuePrecision': [`${rv}Other`] }),
  ).toBe(false);
  expect(
    await accepts({ ...unqualified(), ...qualification(), 'rv:valueQualifier': [`${rv}Other`] }),
  ).toBe(false);
  expect(
    await accepts({
      ...unqualified(),
      ...qualification(),
      'rv:valueQualifier': [`${rv}InferredValue`, `${rv}InferredValue`],
    }),
  ).toBe(false);
});

test('qualification allows either validity bound and absent edition without fabricating values', async () => {
  for (const path of ['rv:validFrom', 'rv:validUntil']) {
    expect(
      await accepts({ ...unqualified(), ...qualification(), [path]: ['2026-10-07T00:00:00Z'] }),
    ).toBe(true);
    expect(await accepts({ ...unqualified(), ...qualification(), [path]: ['2026-10-07'] })).toBe(
      false,
    );
    expect(
      await accepts({
        ...unqualified(),
        ...qualification(),
        [path]: ['2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z'],
      }),
    ).toBe(false);
  }
  expect(
    await accepts({
      ...unqualified(),
      ...qualification(),
      'rv:editionScope': ['urn:edition:first', 'urn:edition:second'],
    }),
  ).toBe(false);
});

test('qualification JSON-LD context retains term kinds across the absent bundle branch', () => {
  const output = buildModelOutputs([profile]).get('generated/model/contexts/statement-v1.jsonld')!;
  const context = (JSON.parse(output) as { '@context': Record<string, unknown> })['@context'];
  for (const path of [
    'qualificationDefinition',
    'interpretationContext',
    'valuePrecision',
    'valueQualifier',
    'editionScope',
  ]) {
    expect(context[`rv:${path}`]).toEqual({ '@id': `${rv}${path}`, '@type': '@id' });
  }
  for (const path of ['validFrom', 'validUntil']) {
    expect(context[`rv:${path}`]).toEqual({ '@id': `${rv}${path}`, '@type': 'xsd:dateTime' });
  }
  expect(context['rdf:object']).toEqual({ '@id': `${rdf}object` });
});
