import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/realm-public-profile-v1>' as const;
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

/** The payload is bounded and checked by the owner before its immutable revision is admitted. */
export const realmPublicProfile = {
  id: 'realm-public-profile-v1',
  comments: ['Public Realm presentation is an independent, receipted revision.',
    'A manager nomination never publishes a moderator without the Agent public choice.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/realm-public-profile-v1/moderator-slot-shape',
      canonical: { types: ['rv:RealmModeratorPublicChoice'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RealmModeratorPublicChoice', maxCount: 1 },
        { path: 'rv:realm', minCount: 1, maxCount: 1, class: 'rv:Realm' },
        { path: 'rv:agent', minCount: 1, maxCount: 1, class: 'rv:Agent' },
        { path: 'rv:choiceHead', minCount: 1, maxCount: 1,
          class: 'rv:RealmModeratorChoiceRevision' },
      ] },
    { iri: 'https://rezics.com/definition/realm-public-profile-v1/revision-shape',
      canonical: { types: ['rv:RealmPublicProfileRevision'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2,
          in: ['rv:RealmPublicProfileRevision', 'rv:RevisionAnchor'] },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Realm' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:RealmPublicProfileRevision' },
        oneIri('rv:operation'),
        { path: 'rv:profilePayload', minCount: 1, maxCount: 1,
          datatype: 'xsd:string', minLength: 2, maxLength: 16000 },
        { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ] },
    { iri: 'https://rezics.com/definition/realm-public-profile-v1/moderator-choice-shape',
      canonical: { types: ['rv:RealmModeratorChoiceRevision'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2,
          in: ['rv:RealmModeratorChoiceRevision', 'rv:RevisionAnchor'] },
        { path: 'rv:component', minCount: 1, maxCount: 1,
          class: 'rv:RealmModeratorPublicChoice' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:RealmModeratorChoiceRevision' },
        oneIri('rv:operation'),
        { path: 'rv:publicChoice', minCount: 1, maxCount: 1,
          in: ['rv:Accepted', 'rv:Declined'] },
        { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ] },
  ],
} as const satisfies ProfileDefinition;
