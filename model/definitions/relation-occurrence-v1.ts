import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/relation-occurrence-v1>';

export const relationOccurrenceProfile = {
  id: 'relation-occurrence-v1',
  comments: [
    'An identified relation occurrence under an exact relation DefinitionRef, with its immutable revisions.',
    'Each immutable revision lists participations; each binds one role and one participant to exactly one',
    'occurrence. Repeated participants in another association are another occurrence.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['owl', 'http://www.w3.org/2002/07/owl#'],
    ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/relation-occurrence-v1/occurrence-shape',
      canonical: { types: ['rv:RelationOccurrence'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:RelationOccurrence' },
      { path: 'rv:relationDefinition', minCount: 1, maxCount: 1, class: 'rv:DefinitionRevision' },
      { path: 'rv:occurrenceHead', minCount: 1, maxCount: 1, class: 'rv:RelationOccurrenceRevision' },
      { path: 'rv:applicability', maxCount: 8, nodeKind: 'sh:IRI' },
      { path: 'owl:sameAs', maxCount: 0 },
    ] },
    { iri: 'https://rezics.com/definition/relation-occurrence-v1/participation-shape',
      canonical: { types: ['rv:RelationParticipation'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:RelationParticipation' },
      { path: 'rv:occurrence', minCount: 1, maxCount: 1, class: 'rv:RelationOccurrence' },
      { path: 'rv:role', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:participant', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'schema:position', maxCount: 1, datatype: 'xsd:integer', minInclusive: 0, maxInclusive: 1023 },
    ] },
    { iri: 'https://rezics.com/definition/relation-occurrence-v1/revision-shape',
      canonical: { types: ['rv:RelationOccurrenceRevision'] }, properties: [
      { path: 'rdf:type', in: ['rv:RelationOccurrenceRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:RelationOccurrence' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:RelationOccurrenceRevision' },
      { path: 'rv:relationDefinition', minCount: 1, maxCount: 1, class: 'rv:DefinitionRevision' },
      { path: 'rv:lifecycle', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
      { path: 'rv:participation', minCount: 1, maxCount: 64, class: 'rv:RelationParticipation' },
      { path: 'rv:participantCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
        minInclusive: 1, maxInclusive: 64 },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelGeneration', minCount: 1, maxCount: 1, class: 'rv:ModelGeneration' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
