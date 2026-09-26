import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/correction-decision-v1>';

export const correctionDecisionProfile = {
  id: 'correction-decision-v1', layout: 'compact',
  comments: [
    'One terminal decision per correction proposal revision; approval and its one application commit together.',
    'The independence proof is an opaque Access reference. The application preserves effective protection.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: 'https://rezics.com/definition/correction-decision-v1/decision-shape',
      canonical: { types: ['rv:CorrectionDecision'] }, properties: [
      { path: 'rdf:type', in: ['rv:CorrectionDecision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:proposalRevision', minCount: 1, maxCount: 1, class: 'rv:CorrectionProposal' },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:candidateDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:outcome', minCount: 1, maxCount: 1, in: ['rv:Accepted', 'rv:Rejected'] },
      { path: 'rv:ruleRevision', minCount: 1, maxCount: 1, in: ['<urn:rezics:protection-rule:independent-human-review-v1>'] },
      // The decision identity is derived from its proposal revision; there is no decision chain.
      { path: 'rv:predecessor', maxCount: 0 },
      { path: 'rv:evidence', maxCount: 32, nodeKind: 'sh:IRI' },
      { path: 'rv:agent', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:decisionIntent', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 16000 },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ], or: [
      [{ path: 'rv:outcome', hasValue: 'rv:Accepted' },
        { path: 'rv:independenceProof', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' }],
      [{ path: 'rv:outcome', hasValue: 'rv:Rejected' }, { path: 'rv:independenceProof', maxCount: 1, nodeKind: 'sh:IRI' }],
    ] },
    { iri: 'https://rezics.com/definition/correction-decision-v1/application-shape',
      canonical: { types: ['rv:CorrectionApplication'] }, properties: [
      { path: 'rdf:type', in: ['rv:CorrectionApplication', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:proposalRevision', minCount: 1, maxCount: 1, class: 'rv:CorrectionProposal' },
      { path: 'rv:decision', minCount: 1, maxCount: 1, class: 'rv:CorrectionDecision' },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:baseRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:workRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      // Reviewed application advances human control even for a source-proposed candidate.
      { path: 'rv:controlRevision', minCount: 1, maxCount: 1, class: 'rv:EditorialControlRevision' },
      // The preserved protection revision, or rv:Absent when the target had none.
      { path: 'rv:protectionRevision', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
