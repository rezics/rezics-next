import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/context-definition-equivalence-v1>';

/** Reviewed equivalence of two qualified uses in one exact Context revision. */
export const contextDefinitionEquivalenceProfile = {
  id: 'context-definition-equivalence-v1',
  comments: [
    'Equivalence is explicit, symmetric and bound to a Context semantic revision and relation.',
    'The mapped targets and DefinitionRefs keep independent identities and old Statement keys.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/context-definition-equivalence-v1/control-shape',
      canonical: { types: ['rv:ContextDefinitionEquivalence'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ContextDefinitionEquivalence' },
        { path: 'rv:context', minCount: 1, maxCount: 1, class: 'rv:SemanticContext' },
        { path: 'rv:semanticRevision', minCount: 1, maxCount: 1, class: 'rv:ContextSemanticRevision' },
        { path: 'rv:equivalenceHead', minCount: 1, maxCount: 1, class: 'rv:ContextDefinitionEquivalenceRevision' },
      ],
    },
    { iri: 'https://rezics.com/definition/context-definition-equivalence-v1/revision-shape',
      canonical: { types: ['rv:ContextDefinitionEquivalenceRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:ContextDefinitionEquivalenceRevision', 'rv:RevisionAnchor'],
          minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:ContextDefinitionEquivalence' },
        { path: 'rv:context', minCount: 1, maxCount: 1, class: 'rv:SemanticContext' },
        { path: 'rv:semanticRevision', minCount: 1, maxCount: 1, class: 'rv:ContextSemanticRevision' },
        { path: 'rv:entryRelation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:leftTarget', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:rightTarget', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:leftDefinition', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:rightDefinition', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:reviewedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
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
