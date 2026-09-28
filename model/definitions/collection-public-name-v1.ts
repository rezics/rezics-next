import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/collection-public-name-v1>' as const;

/** The name payload is validated as localized text by Main before publication. */
export const collectionPublicNameProfile = {
  id: 'collection-public-name-v1',
  comments: ['A Collection name revision stores up to 20 language labels and one original language.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{ iri: 'https://rezics.com/definition/collection-public-name-v1/revision-shape',
    canonical: { types: ['rv:CollectionNameRevision'],
      when: [{ path: 'rv:modelRevision', value: definition }] },
    properties: [
      { path: 'rdf:type', minCount: 2, maxCount: 2,
        in: ['rv:CollectionNameRevision', 'rv:RevisionAnchor'] },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Collection' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:CollectionNameRevision' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:profilePayload', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', minLength: 2, maxLength: 8000 },
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] }],
} as const satisfies ProfileDefinition;
