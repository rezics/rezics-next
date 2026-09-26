import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

// Source reliability is scoped by source, domain definition and evaluation context.
const reliabilityScope: readonly PropertyDefinition[] = [
  requiredIri('rv:assessedSource'),
  requiredIri('rv:domainDefinition'),
  requiredIri('rv:evaluationContext'),
];

// Method output with its limits. A score is never a calibrated fact probability
// unless the assessment names its calibration evidence.
const method: readonly PropertyDefinition[] = [
  requiredIri('rv:method'),
  requiredIri('rv:methodRevision'),
  { path: 'rv:calibration', maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:scorePerMillion', maxCount: 1, datatype: 'xsd:integer', minInclusive: 0, maxInclusive: 1000000 },
  { path: 'rv:scoreCalibration', maxCount: 1, in: ['rv:CalibratedScore', 'rv:UncalibratedScore'] },
  { path: 'rv:limitations', minCount: 1, maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 2000 },
  requiredIri('rv:assessor'),
  { path: 'rv:assessorKind', minCount: 1, maxCount: 1, in: ['rv:HumanAssessor', 'rv:AutomatedAssessor'] },
  { path: 'rv:assessedAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' },
  { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/assessment-v1>', maxCount: 1 },
  { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/assessment-v1>', maxCount: 1 },
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
];

export const assessmentProfile = {
  id: 'assessment-v1',
  comments: [
    'Immutable assessment anchors: scoped source reliability and one claim assessment revision.',
    'An assessment cites exact claim, evidence-set, source-assessment, method and policy revisions.',
    'Activation into a quality summary is a separate Content-owned generation CAS.',
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
      iri: 'https://rezics.com/definition/assessment-v1/reliability-scope-shape',
      canonical: { types: ['rv:SourceReliabilityScope'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:SourceReliabilityScope' },
        ...reliabilityScope,
        { path: 'rv:reliabilityHead', minCount: 1, maxCount: 1, class: 'rv:SourceReliabilityAssessment' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/assessment-v1/reliability-shape',
      canonical: { types: ['rv:SourceReliabilityAssessment'] },
      properties: [
        { path: 'rdf:type', in: ['rv:SourceReliabilityAssessment', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:SourceReliabilityScope' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:SourceReliabilityAssessment' },
        ...reliabilityScope,
        { path: 'rv:applicableFrom', maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'rv:applicableUntil', maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'rv:reliabilityResult', minCount: 1, maxCount: 1,
          in: ['rv:ReliableForDomain', 'rv:MixedReliability', 'rv:UnreliableForDomain', 'rv:UntestedForDomain'] },
        { path: 'rv:inputManifestDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
        { path: 'rv:inputCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 0, maxInclusive: 32 },
        { path: 'rv:rationale', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 4000 },
        ...method,
      ],
    },
    {
      iri: 'https://rezics.com/definition/assessment-v1/assessment-shape',
      canonical: { types: ['rv:ClaimAssessment'] },
      properties: [
        { path: 'rdf:type', in: ['rv:ClaimAssessment', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Claim' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ClaimAssessment' },
        { path: 'rv:claimRevision', minCount: 1, maxCount: 1, class: 'rv:ClaimRevision' },
        // Content-owned verification.evidence_set_revision, by exact identity.
        requiredIri('rv:evidenceSetRevision'),
        { path: 'rv:sourceAssessment', maxCount: 32, class: 'rv:SourceReliabilityAssessment' },
        requiredIri('rv:policyRevision'),
        requiredIri('rv:evaluationContext'),
        { path: 'rv:coverage', minCount: 1, maxCount: 1,
          in: ['rv:CompleteCoverage', 'rv:PartialCoverage', 'rv:IncompleteCoverage'] },
        { path: 'rv:supportResult', minCount: 1, maxCount: 1,
          in: ['rv:Supported', 'rv:Contradicted', 'rv:MaterialConflict', 'rv:InsufficientSupport', 'rv:Abstained'] },
        { path: 'rv:dependenceStatus', minCount: 1, maxCount: 1,
          in: ['rv:DependenceEstablished', 'rv:DependenceUnknown', 'rv:DependenceCircular', 'rv:DependenceOverBudget'] },
        ...method,
      ],
      // Independent origins are counted only when the dependence closure is established.
      or: [
        [
          { path: 'rv:dependenceStatus', hasValue: 'rv:DependenceEstablished' },
          { path: 'rv:independentOriginCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
            minInclusive: 0, maxInclusive: 64 },
        ],
        [
          { path: 'rv:dependenceStatus', in: ['rv:DependenceUnknown', 'rv:DependenceCircular', 'rv:DependenceOverBudget'] },
          { path: 'rv:independentOriginCount', maxCount: 0 },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
