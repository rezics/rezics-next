import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import { renderProfile, type PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { profileSource } from '../compiler/shacl.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const ids = ['source-field-statement-v1', 'source-open-library-work-v1', 'source-reification-v1'];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const options = { established: {}, canonicalOrder: [], demandOrder: [] };
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/source-turtle-'));
  temporary.push(path);
  return path;
}
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const normalize = (properties: readonly PropertyDefinition[]) =>
  properties
    .map((property) =>
      Object.fromEntries(Object.entries(property).sort(([a], [b]) => a.localeCompare(b))),
    )
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));

// Captured from the previous authored definitions, before the source-language conversion.
const original = {
  'source-field-statement-v1': {
    source: 'ef3347dcf04ad576bb156afcfcbb8b35316abaeb3700dc30f2d4827e686594d2',
    shapes: { statement: [23, 'c1888373b9796b94b979cf0ff8956e103eb92f0e2acc7822f35239b668fd960d'] },
  },
  'source-open-library-work-v1': {
    source: '708b975233ceb3e4dc670ff4821011ba91c938a73c9739cfe94052ebdf22ce07',
    shapes: {
      record: [4, '9dec646ae5d55185a684eaaeef3b28c4f11c512aba02a0672b494772c1a715e4'],
      observation: [9, '6d86c70555127e00999ca96b151b97944925fd493fbc4868870c67b942ccd65c'],
      conversion: [9, '753715a14c7a0f42d39966e30276973114c98009403cf28883231482d98bf3dd'],
    },
  },
  'source-reification-v1': {
    source: '57e5a667cb62b1b72357b77aa2c7ac6133ed4f729732e681817ad1c537839100',
    shapes: { statement: [11, '56490a67dc926f55ccddb28e89596d036231669108fa40d841d3efb317862cb8'] },
  },
} as const;

const outputs = buildModelOutputs(profiles);
let schemaPromise: Promise<Record<string, TSchema>> | undefined;
function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  const shape = (await schemas())[`${definition}${id}/${role}-shape`]!;
  return Value.Check(shape, value);
}
const node = (type: string, values: Record<string, unknown>) => ({
  '@id': 'urn:source:focus',
  'rdf:type': [`${rv}${type}`],
  ...values,
});
const field = () =>
  node('SourceStatement', {
    'rv:sourceConversion': ['urn:source:conversion'],
    'rv:sourceMappingRevision': ['test-map-v1'],
    'rv:sourceGrain': ['quantity'],
    'rv:sourceField': ['amount'],
    'rv:sourceOccurrence': ['urn:source:occurrence'],
    'rv:sourceOrdinal': [0],
    'rv:sourceStatementRole': ['main'],
    'rv:fieldDisposition': ['structured-source-only'],
    'rv:dispositionReason': ['Exact source evidence.'],
    'rv:sourceValueKind': ['value'],
    'rv:sourceByteDigest': ['a'.repeat(64)],
  });
const reification = () => ({
  '@id': 'urn:source:statement',
  'rdf:type': ['http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement'],
  'rdf:subject': ['urn:source:conversion'],
  'rdf:predicate': [`${rv}sourceTitle`],
  'rdf:object': ['Exact title\n"quoted" 雨'],
  'prov:wasDerivedFrom': ['urn:source:observation'],
  'rv:sourceObservation': ['urn:source:observation'],
  'rv:sourceByteDigest': ['a'.repeat(64)],
  'rv:sourceMappingRevision': ['open-library-work-map-v1'],
  'rv:sourceField': ['title'],
  'rv:fieldDisposition': ['structured-source-only'],
  'rv:dispositionReason': [
    'Source evidence requires separate explicit acceptance before native use.',
  ],
});
const record = () =>
  node('SourceRecord', {
    'rv:sourceProvider': ['open-library'],
    'rv:sourceNamespace': ['work'],
    'rv:sourceExternalId': ['OL1W'],
  });
const observation = () =>
  node('SourceObservation', {
    'rv:sourceRecord': ['urn:source:record'],
    'rv:sourceByteDigest': ['a'.repeat(64)],
    'rv:sourceCoverage': [`${rv}CompleteWorkResponse`],
    'rv:sourceRightsBasis': ['unknown'],
    'rv:sourceRightsNote': [''],
    'rv:sourceSubmittedAt': ['source lexical timestamp'],
    'rv:sourceFetchedAt': ['source lexical timestamp'],
  });
const conversion = () =>
  node('SourceConversion', {
    'rv:sourceObservation': ['urn:source:observation'],
    'rv:sourceKey': ['/works/OL1W'],
    'rv:sourceTitle': ['Exact title 雨'],
    'rv:sourceAuthorRefsJson': ['null'],
    'rv:sourceSubjectsJson': ['[" exact "]'],
    'rv:sourceByteDigest': ['a'.repeat(64)],
    'rv:sourceMappingRevision': ['open-library-work-map-v1'],
  });

test('source Turtle discovery preserves every original constraint and command focus role', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, []);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  const command = commandProfiles(discovered, options);
  for (const profile of discovered) {
    const baseline = original[profile.id as keyof typeof original];
    const shapes = Object.entries(baseline.shapes);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      shapes.map(([role]) => `${definition}${profile.id}/${role}-shape`),
    );
    for (const [index, [, [count, hash]]] of shapes.entries()) {
      const shape = profile.shapes[index]!;
      expect(shape.properties).toHaveLength(count);
      expect(digest(JSON.stringify(normalize(shape.properties)))).toBe(hash);
      expect(shape.canonical).toBeUndefined();
    }
    expect(profile.binding).toBeUndefined();
    const published = command.profiles.find((item) => item.id === profile.id)!;
    expect(published.focusRoles).toEqual(shapes.map(([role]) => role));
    expect(command.shapes.get(published.file)).toBe(profileSource(profile));
    expect(published.sha256).toBe(digest(profileSource(profile)));
    expect(published.sha256).not.toBe(baseline.source);
  }
});

test('source author reload changes current byte digests without rewriting retained artifacts or records', () => {
  const path = directory();
  for (const profile of profiles)
    writeFileSync(join(path, `${profile.id}.ttl`), profileSource(profile));
  const beforeProfiles = discoverProfiles(path, []);
  const before = commandProfiles(beforeProfiles, options);
  const historicalProfiles = beforeProfiles.map((profile) => ({
    ...profile,
    layout: 'expanded' as const,
    comments: profileSource(profile)
      .split('\n')
      .filter((line) => line.startsWith('# '))
      .map((line) => line.slice(2)),
  }));
  const historical = commandProfiles(historicalProfiles, options);
  for (const profile of historicalProfiles) {
    expect(digest(renderProfile(profile))).toBe(
      original[profile.id as keyof typeof original].source,
    );
  }
  const records = historical.profiles.map((profile) => ({
    profile: profile.id,
    shapeSha256: profile.sha256,
    sourceByteDigest: 'b'.repeat(64),
  }));
  const retained = structuredClone({
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    manifest: historical.manifest,
    records,
  });
  for (const profile of profiles)
    writeFileSync(
      join(path, `${profile.id}.ttl`),
      `${profileSource(profile)}\n# Author byte revision: constraints remain identical.\n`,
    );
  const afterProfiles = discoverProfiles(path, []);
  const after = commandProfiles(afterProfiles, options);
  for (const [index, profile] of beforeProfiles.entries()) {
    expect(after.profiles[index]!.sha256).not.toBe(before.profiles[index]!.sha256);
    expect(after.profiles[index]!.sha256).toBe(digest(profileSource(afterProfiles[index]!)));
    expect(afterProfiles[index]!.shapes).toEqual(profile.shapes);
  }
  expect(commandProfiles(historicalProfiles, options).profiles).toEqual(retained.profiles);
  expect([...commandProfiles(historicalProfiles, options).shapes]).toEqual(retained.shapes);
  expect(historical.profiles).toEqual(retained.profiles);
  expect([...historical.shapes]).toEqual(retained.shapes);
  expect(historical.manifest).toEqual(retained.manifest);
  for (const profile of historical.profiles)
    expect(digest(historical.shapes.get(profile.file)!)).toBe(profile.sha256);
  expect(records).toEqual(retained.records);
});

test('source field Turtle keeps exact lexical, datatype, language and non-value distinctions', async () => {
  const id = 'source-field-statement-v1';
  const exact = {
    ...field(),
    'rv:sourceLexical': ['+00012.3400'],
    'rv:sourceDatatype': ['http://www.w3.org/2001/XMLSchema#decimal'],
    'rv:sourceLanguage': ['ZH-Hant'],
    'rv:sourceRank': ['preferred'],
    'rv:sourceTimePrecision': [14],
    'rv:sourceCalendar': ['urn:calendar:gregorian'],
    'rv:sourceQuantityUnit': ['urn:quantity:unit'],
    'rv:sourceQuantityLower': ['+00012.3300'],
    'rv:sourceQuantityUpper': ['+00012.3500'],
    'rv:sourceStatisticKind': ['score-average'],
  };
  const preserved = structuredClone(exact);
  expect(await accepts(id, 'statement', exact)).toBe(true);
  expect(exact).toEqual(preserved);
  for (const kind of ['value', 'somevalue', 'novalue', 'null', 'unknown'])
    expect(await accepts(id, 'statement', { ...field(), 'rv:sourceValueKind': [kind] })).toBe(true);
  for (const role of ['main', 'qualifier', 'reference'])
    expect(await accepts(id, 'statement', { ...field(), 'rv:sourceStatementRole': [role] })).toBe(
      true,
    );
  for (const lexical of ['', '"quoted"\n雨', '0'.repeat(65536)])
    expect(await accepts(id, 'statement', { ...field(), 'rv:sourceLexical': [lexical] })).toBe(
      true,
    );
  for (const [property, value] of [
    ['rv:sourceLexical', 12.34],
    ['rv:sourceLexical', null],
    ['rv:sourceLexical', '0'.repeat(65537)],
    ['rv:sourceDatatype', { '@value': 'decimal' }],
    ['rv:sourceLanguage', 'zh_Hant'],
    ['rv:sourceMappingRevision', 'Test Map V1'],
    ['rv:sourceGrain', 'invalid_grain'],
    ['rv:sourceOrdinal', -1],
    ['rv:sourceOrdinal', 65536],
    ['rv:sourceOrdinal', 0.5],
    ['rv:sourceOrdinal', '0'],
    ['rv:sourceTimePrecision', -1],
    ['rv:sourceTimePrecision', 15],
    ['rv:sourceValueKind', 'none'],
    ['rv:sourceStatementRole', 'native'],
    ['rv:sourceRank', 'NORMAL'],
    ['rv:fieldDisposition', `${rv}native`],
    ['rv:sourceStatisticKind', 'rating'],
    ['rv:sourceByteDigest', 'A'.repeat(64)],
    ['rv:sourceField', ''],
  ] as const)
    expect(await accepts(id, 'statement', { ...field(), [property]: [value] })).toBe(false);
  expect(await accepts(id, 'statement', { ...field(), 'rv:sourceOrdinal': [65535] })).toBe(true);
});

test('source reification Turtle distinguishes literal claims from native predicates and fixed IRIs', async () => {
  const id = 'source-reification-v1';
  expect(await accepts(id, 'statement', reification())).toBe(true);
  expect(
    await accepts(id, 'statement', {
      ...reification(),
      'rdf:predicate': [`${rv}sourceDescription`],
      'rv:sourceField': ['description'],
    }),
  ).toBe(true);
  for (const [property, value] of [
    ['rdf:predicate', 'sourceTitle'],
    ['rdf:predicate', 'https://schema.org/name'],
    ['rdf:object', { '@value': 'Exact title', '@language': 'en' }],
    ['rdf:object', 'x'.repeat(65537)],
    ['rv:sourceField', `${rv}title`],
    ['rv:fieldDisposition', `${rv}structured-source-only`],
    ['rv:fieldDisposition', 'native'],
    ['rv:sourceMappingRevision', 'open-library-work-map-v2'],
    ['rv:dispositionReason', 'Source evidence requires acceptance.'],
    ['rv:sourceByteDigest', 'short'],
  ] as const)
    expect(await accepts(id, 'statement', { ...reification(), [property]: [value] })).toBe(false);
});

test('source Open Library Turtle retains record, observation and conversion counterexamples', async () => {
  const id = 'source-open-library-work-v1';
  for (const [role, value] of [
    ['record', record()],
    ['observation', observation()],
    ['conversion', conversion()],
  ] as const)
    expect(await accepts(id, role, value)).toBe(true);
  for (const externalId of ['OL0W', 'OL1A', 'OL1234567890123W', '/works/OL1W'])
    expect(await accepts(id, 'record', { ...record(), 'rv:sourceExternalId': [externalId] })).toBe(
      false,
    );
  expect(
    await accepts(id, 'record', { ...record(), 'rv:sourceProvider': [`${rv}open-library`] }),
  ).toBe(false);
  expect(await accepts(id, 'record', { ...record(), 'rv:sourceNamespace': ['author'] })).toBe(
    false,
  );
  for (const basis of ['unknown', 'facts', 'original', 'license', 'permission', 'exception'])
    expect(
      await accepts(id, 'observation', { ...observation(), 'rv:sourceRightsBasis': [basis] }),
    ).toBe(true);
  for (const [property, value] of [
    ['rv:sourceRightsBasis', 'public'],
    ['rv:sourceCoverage', 'CompleteWorkResponse'],
    ['rv:sourceByteDigest', 'a'.repeat(63)],
    ['rv:sourceRevision', 'x'.repeat(201)],
    ['rv:sourceRightsNote', 'x'.repeat(1025)],
  ] as const)
    expect(await accepts(id, 'observation', { ...observation(), [property]: [value] })).toBe(false);
  for (const [property, value] of [
    ['rv:sourceKey', '/works/OL0W'],
    ['rv:sourceTitle', ''],
    ['rv:sourceTitle', 'x'.repeat(501)],
    ['rv:sourceDescription', 'x'.repeat(65537)],
    ['rv:sourceAuthorRefsJson', null],
    ['rv:sourceSubjectsJson', []],
    ['rv:sourceMappingRevision', 'open-library-work-map-v2'],
  ] as const)
    expect(await accepts(id, 'conversion', { ...conversion(), [property]: [value] })).toBe(false);
});

test('source contexts explicitly keep lexical literals, numeric envelopes and RDF IRI values separate', () => {
  const context = (id: string) =>
    JSON.parse(outputs.get(`generated/model/contexts/${id}.jsonld`)!)['@context'];
  const fieldContext = context('source-field-statement-v1');
  for (const property of [
    'sourceLexical',
    'sourceLanguage',
    'sourceQuantityLower',
    'sourceValueKind',
    'sourceStatementRole',
  ])
    expect(fieldContext[`rv:${property}`]).toEqual({ '@id': `${rv}${property}` });
  expect(fieldContext['rv:sourceDatatype']).toEqual({
    '@id': `${rv}sourceDatatype`,
    '@type': '@id',
  });
  expect(fieldContext['rv:sourceOrdinal']).toEqual({
    '@id': `${rv}sourceOrdinal`,
    '@type': 'xsd:integer',
  });
  const reificationContext = context('source-reification-v1');
  expect(reificationContext['rdf:predicate']['@type']).toBe('@id');
  for (const property of ['rdf:object', 'rv:fieldDisposition', 'rv:sourceMappingRevision'])
    expect(reificationContext[property]['@type']).toBeUndefined();
  const libraryContext = context('source-open-library-work-v1');
  expect(libraryContext['rv:sourceCoverage']['@type']).toBe('@id');
  for (const property of ['rv:sourceRightsBasis', 'rv:sourceProvider', 'rv:sourceAuthorRefsJson'])
    expect(libraryContext[property]['@type']).toBeUndefined();
});
