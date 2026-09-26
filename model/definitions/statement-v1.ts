import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/statement-v1>';

/**
 * An identified binary claim reuses rdf:Statement without a duplicate local class.
 * Describing the claim does not assert its base triple; acceptance is a separate decision.
 */
export const statementProfile = {
  id: 'statement-v1',
  comments: [
    'An identified rdf:Statement with exact relation and interpretation DefinitionRefs.',
    'Meaning-bearing fields are fixed per Statement; revisions change only lifecycle and evidence.',
    'The meaning key excludes speaker, Context identity and preference revision.',
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
      iri: 'https://rezics.com/definition/statement-v1/statement-shape',
      canonical: { types: ['rdf:Statement'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rdf:Statement' },
        { path: 'rdf:subject', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rdf:predicate', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rdf:object', minCount: 1, maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
        { path: 'rv:relationDefinition', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:interpretationDefinition', maxCount: 8, nodeKind: 'sh:IRI' },
        { path: 'rv:semanticContextRevision', maxCount: 1, class: 'rv:ContextSemanticRevision' },
        { path: 'rv:speaker', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:applicability', maxCount: 8, nodeKind: 'sh:IRI' },
        { path: 'rv:meaningKey', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:statementState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Withdrawn'] },
        { path: 'rv:head', minCount: 1, maxCount: 1, class: 'rv:StatementRevision' },
        { path: 'rv:source', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:migratedFrom', maxCount: 1, class: 'rv:ClassificationApplication' },
        { path: 'rv:principal', maxCount: 0 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/statement-v1/revision-shape',
      canonical: { types: ['rv:StatementRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:StatementRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rdf:Statement' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:StatementRevision' },
        { path: 'rv:statementState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Withdrawn'] },
        { path: 'rv:evidence', maxCount: 16, nodeKind: 'sh:IRI' },
        { path: 'rv:recordedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
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
