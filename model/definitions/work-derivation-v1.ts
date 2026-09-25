import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/work-derivation-v1>' as const;

export const workDerivationProfile = {
  id: 'work-derivation-v1',
  comments: [
    'One explicitly declared derivation of a separately maintained target Work revision.',
    'The source is an exact retained Main Version revision; names and bodies do not establish continuity.',
    'The relation does not transfer rights, authority, ratings, or future revisions.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/work-derivation-v1/derivation-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:WorkDerivation', maxCount: 1 },
      { path: 'rv:targetWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:targetMainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:targetMainRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:sourceWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:sourceMainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:sourceMainRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:derivationKind', minCount: 1, maxCount: 1,
        in: ['rv:Adaptation', 'rv:NewRecording', 'rv:SoftwareFork'] },
      { path: 'rv:evidence', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^https://[^\\s<>"{}|\\^`]{1,2040}$' },
      { path: 'rv:linkedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1,
        datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }],
} as const satisfies ProfileDefinition;
