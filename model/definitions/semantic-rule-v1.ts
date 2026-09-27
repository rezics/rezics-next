import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/semantic-rule-v1>';

/** Exact finite-rule revisions and a single generation head per Context/Realm/output slot. */
export const semanticRuleProfile = {
  id: 'semantic-rule-v1',
  comments: [
    'The executable positive body is sealed in the immutable manifest and checked by the semantic owner.',
    'The rule head and derived generation switch atomically; dependent targets are never rewritten on revision.',
    'Output predicates are admitted only in the derived projection namespace, outside owner authority.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/semantic-rule-v1/slot-shape',
      canonical: { types: ['rv:ContextRule'] }, properties: [
        { path: 'rdf:type', hasValue: 'rv:ContextRule' },
        { path: 'rv:context', minCount: 1, maxCount: 1, class: 'rv:SemanticContext' },
        { path: 'rv:realm', minCount: 1, maxCount: 1, class: 'rv:Realm' },
        { path: 'rv:outputPredicate', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:ruleHead', minCount: 1, maxCount: 1, class: 'rv:FiniteRuleRevision' },
        { path: 'rv:derivedGenerationHead', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      ] },
    { iri: 'https://rezics.com/definition/semantic-rule-v1/revision-shape',
      canonical: { types: ['rv:FiniteRuleRevision'] }, properties: [
        { path: 'rdf:type', in: ['rv:FiniteRuleRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:ContextRule' },
        { path: 'rv:context', minCount: 1, maxCount: 1, class: 'rv:SemanticContext' },
        { path: 'rv:contextSemanticRevision', minCount: 1, maxCount: 1, class: 'rv:ContextSemanticRevision' },
        { path: 'rv:realm', minCount: 1, maxCount: 1, class: 'rv:Realm' },
        { path: 'rv:outputPredicate', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:derivedGeneration', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelGeneration', minCount: 1, maxCount: 1, class: 'rv:ModelGeneration' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:FiniteRuleRevision' },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ] },
    { iri: 'https://rezics.com/definition/semantic-rule-v1/dependency-shape',
      canonical: { types: ['rv:RuleDependency'] }, properties: [
        { path: 'rdf:type', hasValue: 'rv:RuleDependency' },
        { path: 'rv:ruleSlot', minCount: 1, maxCount: 1, class: 'rv:ContextRule' },
        { path: 'rv:target', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:dependencyGeneration', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      ] },
    { iri: 'https://rezics.com/definition/semantic-rule-v1/dependency-page-shape',
      canonical: { types: ['rv:RuleDependencyPage'] }, properties: [
        { path: 'rdf:type', in: ['rv:RuleDependencyPage', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:ContextRule' },
        { path: 'rv:derivedGeneration', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ] },
  ],
} as const satisfies ProfileDefinition;
