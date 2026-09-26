import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const common: readonly PropertyDefinition[] = [
  { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
  { path: 'schema:roleName', hasValue: '"author"', maxCount: 1 },
  { path: 'rv:externalProvider', hasValue: '"open-library"', maxCount: 1 },
  { path: 'rv:externalNamespace', hasValue: '"author"', maxCount: 1 },
  { path: 'rv:externalKey', minCount: 1, maxCount: 1, datatype: 'xsd:string',
    pattern: '^/authors/OL[1-9][0-9]{0,11}A$' },
  { path: 'rv:sourceRoleKey', maxCount: 1, datatype: 'xsd:string', maxLength: 200 },
  { path: 'schema:position', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
    minInclusive: 0, maxInclusive: 127 },
  { path: 'rv:editControl', hasValue: 'rv:HumanConfirmed', maxCount: 1 },
  { path: 'rv:rightsStatus', hasValue: 'rv:Undetermined', maxCount: 1 },
  { path: 'rv:agent', maxCount: 0 },
  { path: 'schema:author', maxCount: 0 },
];

export const workAuthorCreditProfile = {
  id: 'work-author-credit-v1',
  comments: [
    'One immutable, human-confirmed author-credit occurrence with an external participant reference.',
    'A source author key does not identify a native Agent. Repeated keys retain separate credit identities.',
    'The source owner keeps private support and correspondence separately from native identity.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/work-author-credit-v1/credit-shape', properties: [
      { path: 'rdf:type', hasValue: 'rv:AuthorCredit', maxCount: 1 },
      { path: 'rv:creditRevision', minCount: 1, maxCount: 1, class: 'rv:AuthorCreditRevision' },
      ...common,
    ] },
    { iri: 'https://rezics.com/definition/work-author-credit-v1/revision-shape', properties: [
      { path: 'rdf:type', in: ['rv:AuthorCreditRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:AuthorCredit' },
      { path: 'rv:predecessor', maxCount: 0 },
      { path: 'rv:confirmedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:workRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/work-author-credit-v1>', maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/work-author-credit-v1>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ...common,
    ] },
  ],
} as const satisfies ProfileDefinition;
