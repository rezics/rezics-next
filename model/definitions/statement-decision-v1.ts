import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/statement-decision-v1>';

/**
 * The single acceptance-decision model for Statements and qualified fact slots.
 * It reuses the retained ClassificationContext records as acceptance scopes; it
 * never treats them as interpretation Contexts. Retained v1 decisions are frozen
 * history referenced through rv:convertedFrom.
 */
export const statementDecisionProfile = {
  id: 'statement-decision-v1',
  comments: [
    'One decision head per exact Statement or qualified-fact slot and acceptance scope.',
    'Decision revisions are immutable; Withdrawn is explicit absence, never unreadable state.',
    'Migrated heads reference their exact retained classification-direct-decision-v1 revision.',
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
      iri: 'https://rezics.com/definition/statement-decision-v1/slot-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:DecisionSlot' },
        { path: 'rv:acceptanceContext', minCount: 1, maxCount: 1, class: 'rv:ClassificationContext' },
        { path: 'rv:decisionHead', minCount: 1, maxCount: 1, class: 'rv:StatementDecision' },
      ],
      or: [
        [
          { path: 'rv:targetKind', hasValue: 'rv:StatementTarget', minCount: 1, maxCount: 1 },
          { path: 'rv:decisionTarget', minCount: 1, maxCount: 1, class: 'rdf:Statement' },
        ],
        [
          { path: 'rv:targetKind', hasValue: 'rv:QualifiedFactTarget', minCount: 1, maxCount: 1 },
          { path: 'rv:decisionTarget', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/statement-decision-v1/decision-shape',
      properties: [
        { path: 'rdf:type', in: ['rv:StatementDecision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:DecisionSlot' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:StatementDecision' },
        { path: 'rv:outcome', minCount: 1, maxCount: 1, in: ['rv:Accepted', 'rv:Rejected', 'rv:Withdrawn'] },
        { path: 'rv:decisionBasis', minCount: 1, maxCount: 1,
          in: ['rv:GlobalCuratorReview', 'rv:RealmManagerReview'] },
        { path: 'rv:decidedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:decisionPolicy', hasValue: PROFILE, maxCount: 1 },
        { path: 'rv:contextRevision', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:targetRevision', maxCount: 1, class: 'rv:StatementRevision' },
        { path: 'rv:support', maxCount: 32, class: 'rdf:Statement' },
        { path: 'rv:evidence', maxCount: 16, nodeKind: 'sh:IRI' },
        { path: 'rv:convertedFrom', maxCount: 1, class: 'rv:ClassificationDecision' },
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
