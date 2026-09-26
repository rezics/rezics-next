import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/work-derivation-unresolved-v1>' as const;

export const workDerivationUnresolvedProfile = {
  id: 'work-derivation-unresolved-v1',
  comments: [
    'One explicitly declared derivation of a target Work revision whose source version is not yet known.',
    'The source names a Work and its Main Version without an exact revision; it is never an exact declaration.',
    'A later exact declaration resolves it through rv:corrects; this relation stays unchanged and readable.',
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
    iri: 'https://rezics.com/definition/work-derivation-unresolved-v1/derivation-shape',
    canonical: { types: ['rv:UnresolvedWorkDerivation'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:UnresolvedWorkDerivation', maxCount: 1 },
      { path: 'rv:targetWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:targetMainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:targetMainRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:sourceWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:sourceMainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:sourceMainRevision', maxCount: 0 },
      { path: 'rv:sourceVersionStatus', hasValue: 'rv:Unresolved', minCount: 1, maxCount: 1 },
      { path: 'rv:derivationKind', minCount: 1, maxCount: 1,
        in: ['rv:Adaptation', 'rv:NewRecording', 'rv:SoftwareFork'] },
      { path: 'rv:evidence', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^https://[^\\s<>"{}|\\^`]{1,2040}$' },
      { path: 'rv:linkedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:corrects', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1,
        datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }],
  // Registry-only binding: the module applies the generic key and role checks, and
  // the native command's fixed-key guards hold the value checks.
  binding: {
    required: ['derivation', 'target-work', 'target-main', 'target-revision', 'source-work',
      'source-main', 'kind', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
    roles: ['derivation'], demandedBy: ['rv:UnresolvedWorkDerivation'],
  },
} as const satisfies ProfileDefinition;
