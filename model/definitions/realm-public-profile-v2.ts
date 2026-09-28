import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/realm-public-profile-v2>' as const;

/** Localized payload validation belongs to Main; graph validation fences the immutable revision. */
export const realmPublicV2Profile = {
  id: 'realm-public-profile-v2',
  comments: ['A Realm profile has independently localized name, description and rules.',
    'The name on its Space is the original label of the current profile.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{ iri: 'https://rezics.com/definition/realm-public-profile-v2/revision-shape',
    canonical: { types: ['rv:RealmPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: definition }] },
    properties: [
      { path: 'rdf:type', minCount: 2, maxCount: 2,
        in: ['rv:RealmPublicProfileRevision', 'rv:RevisionAnchor'] },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Realm' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:RealmPublicProfileRevision' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:profilePayload', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', minLength: 2, maxLength: 16000 },
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] }],
} as const satisfies ProfileDefinition;
