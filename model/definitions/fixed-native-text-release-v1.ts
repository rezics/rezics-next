import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/fixed-native-text-release-v1>' as const;

export const fixedNativeTextReleaseProfile = {
  id: 'fixed-native-text-release-v1',
  comments: [
    'A separate sealed release pins one exact published native text selection.',
    'Its immutable manifest verifies the selected draft bytes; current Work metadata is not copied.',
    'The owning command guards current eligibility and sealed dependency identities.',
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
    iri: 'https://rezics.com/definition/fixed-native-text-release-v1/release-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:FixedRelease', maxCount: 1 },
      { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:mainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:mainRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:selection', minCount: 1, maxCount: 1, class: 'rv:PublicationSelection' },
      { path: 'rv:contribution', minCount: 1, maxCount: 1, class: 'rv:TextContribution' },
      { path: 'rv:publicationDecision', minCount: 1, maxCount: 1, class: 'rv:PublicationDecision' },
      { path: 'rv:selectedDraft', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:language', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:bodyDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:sealedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
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
