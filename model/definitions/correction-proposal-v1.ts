import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/correction-proposal-v1>';

export const correctionProposalProfile = {
  id: 'correction-proposal-v1', layout: 'compact',
  comments: [
    'Immutable correction proposal revision for one native Work English title slot. It changes no adoption.',
    'The candidate is retained in its manifest; private proposer identity belongs to Access.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    // One current log per target/context bounds history pages without scanning Work-wide revisions.
    { iri: 'https://rezics.com/definition/correction-proposal-v1/log-shape',
      canonical: { types: ['rv:CorrectionLog'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:CorrectionLog' },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:protectedSlot', hasValue: '"title:en"', maxCount: 1 },
      { path: 'rv:adoptionContext', hasValue: 'rv:GlobalNative', maxCount: 1 },
      { path: 'rv:proposalHead', minCount: 1, maxCount: 1, class: 'rv:CorrectionProposal' },
      { path: 'rv:proposalCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
    { iri: 'https://rezics.com/definition/correction-proposal-v1/proposal-shape',
      canonical: { types: ['rv:CorrectionProposal'] }, properties: [
      { path: 'rdf:type', in: ['rv:CorrectionProposal', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:proposal', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:proposalRevisionNumber', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:CorrectionProposal' },
      { path: 'rv:logPredecessor', maxCount: 1, class: 'rv:CorrectionProposal' },
      { path: 'rv:logOrdinal', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:protectedSlot', hasValue: '"title:en"', maxCount: 1 },
      { path: 'rv:adoptionContext', hasValue: 'rv:GlobalNative', maxCount: 1 },
      { path: 'rv:baseRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      // A protection or control revision, or rv:Absent as the explicit absence assertion.
      { path: 'rv:baseProtection', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:baseControl', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:baseControlEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 0 },
      { path: 'rv:ruleRevision', minCount: 1, maxCount: 1, in: ['<urn:rezics:protection-rule:independent-human-review-v1>'] },
      { path: 'rv:proposalOrigin', minCount: 1, maxCount: 1, in: ['rv:HumanProposal', 'rv:SourceProposal'] },
      { path: 'rv:candidateRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:candidateManifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:candidateDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:proposalAdmission', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:evidence', maxCount: 32, nodeKind: 'sh:IRI' },
      { path: 'rv:agent', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:proposalIntent', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 16000 },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ], or: [
      [{ path: 'rv:proposalOrigin', hasValue: 'rv:HumanProposal' }, { path: 'rv:sourceProposal', maxCount: 0 }],
      [{ path: 'rv:proposalOrigin', hasValue: 'rv:SourceProposal' },
        { path: 'rv:sourceProposal', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' }],
    ] },
  ],
} as const satisfies ProfileDefinition;
