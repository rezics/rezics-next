import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/context-v1>';

/** Immutable anchor fields shared by both independently versioned components. */
const anchor: readonly PropertyDefinition[] = [
  { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:SemanticContext' },
  { path: 'rv:authoredBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
  { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
  { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
  { path: 'rv:principal', maxCount: 0 },
];

/** A Context header never names a Realm parent or the private principal that manages it. */
const header: readonly PropertyDefinition[] = [
  { path: 'rdf:type', hasValue: 'rv:SemanticContext' },
  { path: 'rv:semanticHead', minCount: 1, maxCount: 1, class: 'rv:ContextSemanticRevision' },
  { path: 'rv:preferenceHead', maxCount: 1, class: 'rv:ContextPreferenceRevision' },
  { path: 'rv:realm', maxCount: 0 },
  { path: 'rv:principal', maxCount: 0 },
];

export const contextProfile = {
  id: 'context-v1',
  comments: [
    'Shared interpretation Context with independent semantic and preference component heads.',
    'Semantic revisions pin at most one base revision and list sparse, content-addressed entries.',
    'The Global baseline has a fixed identity and no base. No Realm parent or principal link exists.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/context-v1/global-shape',
      canonical: { types: ['rv:SemanticContext'],
        when: [{ path: 'rv:contextRole', value: 'rv:GlobalInterpretation' }] },
      properties: [
        ...header,
        { path: 'rv:contextRole', hasValue: 'rv:GlobalInterpretation', maxCount: 1 },
        { path: 'rv:contextState', hasValue: 'rv:Active', maxCount: 1 },
        { path: 'rv:disclosure', hasValue: 'rv:Public', maxCount: 1 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/context-v1/context-shape',
      canonical: { types: ['rv:SemanticContext'] },
      properties: [
        ...header,
        { path: 'rv:contextRole', hasValue: 'rv:SharedInterpretation', maxCount: 1 },
        { path: 'rv:contextState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
        { path: 'rv:disclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
      ],
    },
    {
      iri: 'https://rezics.com/definition/context-v1/semantic-revision-shape',
      canonical: { types: ['rv:ContextSemanticRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:ContextSemanticRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ContextSemanticRevision' },
        { path: 'rv:baseRevision', maxCount: 1, class: 'rv:ContextSemanticRevision' },
        { path: 'rv:inheritanceDepth', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 8 },
        { path: 'rv:entryCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 256 },
        { path: 'rv:entry', maxCount: 256, class: 'rv:ContextEntry' },
        ...anchor,
      ],
    },
    {
      iri: 'https://rezics.com/definition/context-v1/entry-shape',
      canonical: { types: ['rv:ContextEntry'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ContextEntry', maxCount: 1 },
        { path: 'rv:entryTarget', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:entryRelation', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:applicability', maxCount: 8, nodeKind: 'sh:IRI' },
      ],
      or: [
        [
          { path: 'rv:entryState', hasValue: 'rv:Defined', minCount: 1, maxCount: 1 },
          { path: 'rv:interpretationDefinition', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        ],
        [
          { path: 'rv:entryState', minCount: 1, maxCount: 1, in: ['rv:Unresolved', 'rv:Disabled'] },
          { path: 'rv:interpretationDefinition', maxCount: 0 },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/context-v1/preference-revision-shape',
      canonical: { types: ['rv:ContextPreferenceRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:ContextPreferenceRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ContextPreferenceRevision' },
        { path: 'rv:preferenceCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 256 },
        { path: 'rv:baseRevision', maxCount: 0 },
        { path: 'rv:entry', maxCount: 0 },
        ...anchor,
      ],
    },
  ],
} as const satisfies ProfileDefinition;
