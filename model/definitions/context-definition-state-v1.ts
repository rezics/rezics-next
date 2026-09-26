import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/context-definition-state-v1>';

/** Independent lifecycle control for an exact DefinitionRef, including retained v1 Sense revisions. */
export const contextDefinitionStateProfile = {
  id: 'context-definition-state-v1',
  comments: [
    'A DefinitionRef has a guarded active/retired state independent of Context selection heads.',
    'Retirement stops new Statement use; historical exact Context and Statement references remain readable.',
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
      iri: 'https://rezics.com/definition/context-definition-state-v1/control-shape',
      canonical: { types: ['rv:DefinitionLifecycle'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:DefinitionLifecycle' },
        { path: 'rv:definitionRef', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:definitionState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
        { path: 'rv:definitionHead', minCount: 1, maxCount: 1, class: 'rv:DefinitionLifecycleRevision' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/context-definition-state-v1/revision-shape',
      canonical: { types: ['rv:DefinitionLifecycleRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:DefinitionLifecycleRevision', 'rv:RevisionAnchor'],
          minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:DefinitionLifecycle' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:DefinitionLifecycleRevision' },
        { path: 'rv:definitionRef', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:definitionState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
        { path: 'rv:authoredBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
