import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/context-selection-v1>';

/**
 * Public, graph-owned scoped adoption of a Context by a Realm speaker or an entry point.
 * Private principal selections are Access-owned PostgreSQL rows and never appear here.
 */
export const contextSelectionProfile = {
  id: 'context-selection-v1',
  comments: [
    'Public scoped Context adoption with its own expected head and immutable revisions.',
    'A selection pins one published semantic revision and optionally one preference revision.',
    'Private principal selections are Access-owned and have no graph representation.',
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
      iri: 'https://rezics.com/definition/context-selection-v1/selection-shape',
      canonical: { types: ['rv:ContextSelection'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ContextSelection' },
        { path: 'rv:consumer', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:selectionRole', minCount: 1, maxCount: 1,
          in: ['rv:SpeakerSelection', 'rv:EntryDefault'] },
        { path: 'rv:scopeProfile', hasValue: '<https://rezics.com/definition/context-selection-scope-v1>',
          maxCount: 1 },
        { path: 'rv:selectionKey', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:selectionHead', minCount: 1, maxCount: 1, class: 'rv:ContextSelectionRevision' },
        { path: 'rv:principal', maxCount: 0 },
      ],
      or: [
        [
          { path: 'rv:scopeKind', hasValue: 'rv:DefaultScope', minCount: 1, maxCount: 1 },
          { path: 'rv:scopeObject', maxCount: 0 },
          { path: 'rv:scopeRelation', maxCount: 0 },
          { path: 'rv:scopeDomain', maxCount: 0 },
        ],
        [
          { path: 'rv:scopeKind', hasValue: 'rv:DomainScope', minCount: 1, maxCount: 1 },
          { path: 'rv:scopeObject', maxCount: 0 },
          { path: 'rv:scopeRelation', maxCount: 0 },
          { path: 'rv:scopeDomain', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        ],
        [
          { path: 'rv:scopeKind', hasValue: 'rv:ObjectScope', minCount: 1, maxCount: 1 },
          { path: 'rv:scopeObject', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
          { path: 'rv:scopeRelation', maxCount: 0 },
          { path: 'rv:scopeDomain', maxCount: 0 },
        ],
        [
          { path: 'rv:scopeKind', hasValue: 'rv:ObjectRelationScope', minCount: 1, maxCount: 1 },
          { path: 'rv:scopeObject', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
          { path: 'rv:scopeRelation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
          { path: 'rv:scopeDomain', maxCount: 0 },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/context-selection-v1/revision-shape',
      canonical: { types: ['rv:ContextSelectionRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:ContextSelectionRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:ContextSelection' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ContextSelectionRevision' },
        { path: 'rv:selectedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
      or: [
        [
          { path: 'rv:selectionState', hasValue: 'rv:Selected', minCount: 1, maxCount: 1 },
          { path: 'rv:context', minCount: 1, maxCount: 1, class: 'rv:SemanticContext' },
          { path: 'rv:semanticRevision', minCount: 1, maxCount: 1, class: 'rv:ContextSemanticRevision' },
          { path: 'rv:preferenceRevision', maxCount: 1, class: 'rv:ContextPreferenceRevision' },
        ],
        [
          { path: 'rv:selectionState', hasValue: 'rv:Cleared', minCount: 1, maxCount: 1 },
          { path: 'rv:context', maxCount: 0 },
          { path: 'rv:semanticRevision', maxCount: 0 },
          { path: 'rv:preferenceRevision', maxCount: 0 },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
