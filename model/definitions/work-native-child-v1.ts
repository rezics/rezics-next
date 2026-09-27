import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const common: readonly PropertyDefinition[] = [
  { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
  { path: 'rv:childField', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 100 },
  { path: 'rv:sourceKey', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 200 },
  { path: 'schema:position', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
    minInclusive: 0, maxInclusive: 127 },
  { path: 'rv:editControl', hasValue: 'rv:HumanConfirmed', maxCount: 1 },
  { path: 'rv:rightsStatus', hasValue: 'rv:Undetermined', maxCount: 1 },
];

/** Field-keyed qualified children; provider occurrences never become native IDs. */
export const workNativeChildProfile = {
  id: 'work-native-child-v1', layout: 'compact',
  comments: ['Each native child has its own immutable identity, value revision and retirement marker.',
    'Source observations and correspondence remain in the Source owner.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: 'https://rezics.com/definition/work-native-child-v1/child-shape',
      canonical: { types: ['rv:NativeChild'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:NativeChild' },
      { path: 'rv:childRevision', minCount: 1, maxCount: 1, class: 'rv:NativeChildRevision' },
      { path: 'rv:retiredBy', maxCount: 1, nodeKind: 'sh:IRI' },
      ...common,
    ] },
    { iri: 'https://rezics.com/definition/work-native-child-v1/revision-shape', properties: [
      { path: 'rdf:type', in: ['rv:NativeChildRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:NativeChild' },
      { path: 'rv:workRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:confirmedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:predecessor', maxCount: 0 },
      { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/work-native-child-v1>', maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/work-native-child-v1>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ...common,
    ] },
  ],
} as const satisfies ProfileDefinition;
