import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = 'https://rezics.com/definition/work-metadata-details-v1';
export const workMetadataDetailsProfile = {
  id: 'work-metadata-details-v1', layout: 'compact',
  comments: ['Independent descriptive metadata, bibliographic edition and editor relevance components.',
    'The command validates the bounded discriminated JSON state; SHACL validates its revision envelope.',
    'The original title is explicitly recorded; language alone never marks a title as original.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: `${profile}/work-shape`, properties: [
      { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
      { path: 'rv:descriptiveMetadataHead', minCount: 1, maxCount: 1, class: 'rv:WorkMetadataRevision' },
    ] },
    { iri: `${profile}/component-shape`, canonical: { types: ['rv:WorkMetadataComponent'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:WorkMetadataComponent' },
      { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:metadataKind', minCount: 1, maxCount: 1, in: ['"header"', '"edition"', '"relevance"'] },
      { path: 'rv:metadataHead', minCount: 1, maxCount: 1, class: 'rv:WorkMetadataRevision' },
      { path: 'rv:editionState', maxCount: 1, in: ['rv:Active', 'rv:Withdrawn'] },
      { path: 'rv:editionLanguage', maxCount: 1, datatype: 'xsd:string' },
    ] },
    { iri: `${profile}/revision-shape`, canonical: { types: ['rv:WorkMetadataRevision'] }, properties: [
      { path: 'rdf:type', in: ['rv:WorkMetadataRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:WorkMetadataComponent' },
      { path: 'rv:metadataState', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 65536 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:WorkMetadataRevision' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
