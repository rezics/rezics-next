import type { ProfileDefinition } from '../compiler/ir.ts';

/**
 * A participation written by a v2 command carries `rv:participationFormat` so the
 * canonical route selects this shape; v1 participations carry no marker and keep
 * their reviewed closed shape. Occurrences and revisions stay under v1.
 */
export const relationOccurrenceV2Profile = {
  id: 'relation-occurrence-v2',
  comments: [
    'A relation participation may record the name credited in that occurrence, as one language-tagged literal.',
    'The credited name belongs to the participation only; it never renames the participant.',
    'A v1 participation has no format marker, no credited name and stays valid under its own shape.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/relation-occurrence-v2/participation-shape',
      canonical: { types: ['rv:RelationParticipation'],
        when: [{ path: 'rv:participationFormat', value: 'rv:CreditedNameV2' }] },
      closed: true, properties: [
      { path: 'rdf:type', hasValue: 'rv:RelationParticipation' },
      { path: 'rv:occurrence', minCount: 1, maxCount: 1, class: 'rv:RelationOccurrence' },
      { path: 'rv:role', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:participant', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'schema:position', maxCount: 1, datatype: 'xsd:integer', minInclusive: 0, maxInclusive: 1023 },
      { path: 'rv:participationFormat', hasValue: 'rv:CreditedNameV2', minCount: 1, maxCount: 1 },
      { path: 'rv:creditedName', maxCount: 1, datatype: 'rdf:langString', maxLength: 200 },
    ] },
  ],
} as const satisfies ProfileDefinition;
