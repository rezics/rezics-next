import { expect, test } from 'bun:test';
import { parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { workMetadataProfile } from '../definitions/work-metadata-v1.ts';

const id = workMetadataProfile.id;
const source = profileSource(workMetadataProfile);
const parse = (turtle: string) => parseTurtleProfile(id, turtle);

test('MODEL17: compiler rejects unsupported executable and unreviewed shape terms', () => {
  expect(source).toContain('sh:NodeShape');
  expect(() => parse(source.split('\n').filter(line => line.startsWith('@prefix')).join('\n')))
    .toThrow('distinct named NodeShapes');
  expect(() => parse(source.replace('sh:path rdf:type', 'sh:js "return true" ; sh:path rdf:type')))
    .toThrow('Unsupported SHACL construct sh:js');
  expect(() => parse(source.replace('a sh:NodeShape ;', 'a sh:NodeShape ; sh:sparql "SELECT ?this WHERE {}" ;')))
    .toThrow('Unsupported SHACL construct sh:sparql');
  expect(() => parse(`${source}\n<https://example.org/unreviewed-validator> sh:script "execute" .\n`))
    .toThrow('Unsupported SHACL construct sh:script');
});

test('MODEL13: authored profiles cannot confuse resource, vocabulary or Schema.org namespaces', () => {
  expect(() => parse(`${source}\n@prefix rv: <https://rezics.com/id/> .\n`))
    .toThrow('duplicate prefixes');
  expect(() => parse(source.replace('@prefix rv: <https://rezics.com/vocab/>',
    '@prefix rv: <https://rezics.com/id/>'))).toThrow('binds rv');
  expect(() => parse(source.replace('@prefix schema: <https://schema.org/>',
    '@prefix schema: <http://schema.org/>'))).toThrow('binds schema');
  expect(() => parse(`${source}\n@prefix rezics: <https://rezics.com/vocab/> .\n`))
    .toThrow('binds rezics');
});

test('Turtle identity, namespace and shape boundaries remain required without rendering', () => {
  expect(() => parseTurtleProfile('work_metadata-v1', source.replaceAll(id, 'work_metadata-v1')))
    .toThrow('Invalid profile ID');
  expect(() => parse(source.replaceAll(`https://rezics.com/definition/${id}/`, 'https://example.org/')))
    .toThrow('unnamed focus role');
  expect(() => parse(source.replaceAll('sh:', 'shape:')))
    .toThrow('must declare the sh prefix');
  expect(() => parse(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<https://rezics.com/definition/${id}/empty-shape> a sh:NodeShape .\n`))
    .toThrow('must have properties');
  expect(() => parse(source.replace(`<https://rezics.com/definition/${id}/work-shape>`, '_:work')))
    .toThrow('named NodeShape');
});
