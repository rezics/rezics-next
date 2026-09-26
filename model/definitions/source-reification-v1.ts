import type { ProfileDefinition } from '../compiler/ir.ts';

export const sourceReificationProfile = {
  id: 'source-reification-v1',
  comments: [
    'Private RDF reification of source conversion fields as claims with exact observation provenance.',
    'The statement subject is the source conversion, never an adopted native Work.',
    'Reification records a source claim; it does not assert or accept the base edge.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['prov', 'http://www.w3.org/ns/prov#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'expanded',
  shapes: [
    { iri: 'https://rezics.com/definition/source-reification-v1/statement-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rdf:Statement' },
        { path: 'rdf:subject', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI',
          class: 'rv:SourceConversion' },
        { path: 'rdf:predicate', minCount: 1, maxCount: 1, in: ['rv:sourceTitle', 'rv:sourceDescription'] },
        { path: 'rdf:object', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 65536 },
        { path: 'prov:wasDerivedFrom', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI',
          class: 'rv:SourceObservation' },
        { path: 'rv:sourceObservation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI',
          class: 'rv:SourceObservation' },
        { path: 'rv:sourceByteDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          pattern: '^[0-9a-f]{64}$' },
        { path: 'rv:sourceMappingRevision', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          hasValue: '"open-library-work-map-v1"' },
        { path: 'rv:sourceField', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          in: ['"title"', '"description"'] },
        { path: 'rv:fieldDisposition', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          hasValue: '"structured-source-only"' },
        { path: 'rv:dispositionReason', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          hasValue: '"Source evidence requires separate explicit acceptance before native use."' },
      ] },
  ],
} as const satisfies ProfileDefinition;
