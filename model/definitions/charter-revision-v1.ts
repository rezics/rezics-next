import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const choice = (path: Term, values: readonly Term[]) => one(path, { in: values });
const fixed = (path: Term, hasValue: Term): PropertyDefinition =>
  ({ path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true });
const count = (path: Term, minInclusive: number, maxInclusive: number) =>
  one(path, { datatype: 'xsd:integer', minInclusive, maxInclusive });
const revisionCore: readonly PropertyDefinition[] = [
  { path: 'rdf:type', hasValue: 'rv:VotingCharterRevision' },
  one('rv:charter', { class: 'rv:VotingCharter' }),
  { path: 'rv:predecessor', maxCount: 1, class: 'rv:VotingCharterRevision' },
  one('rv:ruleRevision', { nodeKind: 'sh:IRI' }),
  one('rv:charterDigest', { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' }),
  one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' }),
  one('rv:revisedAt', { datatype: 'xsd:dateTime' }),
];

export const charterRevisionProfile = {
  id: 'charter-revision-v1',
  comments: [
    'Governance voting charters: immutable revisions cited by exact IRI and digest.',
    'An electorate charter fixes counting, quorum, allocation and proxy rules for its polls.',
    'A holder charter fixes how an organizational holder operates and aggregates its one ballot.',
    'Weights and mandates are never inferred from Access membership or graph presence.',
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
      iri: 'https://rezics.com/definition/charter-revision-v1/charter-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:VotingCharter' },
        one('rv:governingBody', { nodeKind: 'sh:IRI' }),
        choice('rv:charterKind', ['rv:ElectorateCharter', 'rv:HolderCharter']),
        one('rv:charterHead', { class: 'rv:VotingCharterRevision' }),
      ],
    },
    {
      iri: 'https://rezics.com/definition/charter-revision-v1/electorate-revision-shape',
      properties: [
        ...revisionCore,
        { path: 'rdf:type', hasValue: 'rv:ElectorateCharterRevision' },
        count('rv:unitScale', 1, 1000000),
        choice('rv:countingUnit', ['rv:WeightUnits', 'rv:SeatCount', 'rv:PersonCount']),
        { path: 'rv:admittedSeatClass', minCount: 1, maxCount: 3,
          in: ['rv:PersonSeat', 'rv:OrganizationSeat', 'rv:CollectiveMemberSeat'] },
        fixed('rv:personCountingBasis', 'rv:AccessPrincipalCounting'),
        choice('rv:allocationPolicy', ['rv:AllocationDisabled', 'rv:ExplicitSeatAllocation']),
        choice('rv:proxyPolicy', ['rv:ProxyDisabled', 'rv:OneHopProxy']),
        choice('rv:holderOverridePolicy', ['rv:HolderOverrideAllowed', 'rv:HolderOverrideDenied']),
        fixed('rv:proxyRoutingPolicy', 'rv:FrozenAtOpening'),
        count('rv:quorumThreshold', 0, 2000000000),
        choice('rv:abstentionPolicy', ['rv:AbstentionCountsForQuorum', 'rv:AbstentionExcludedFromQuorum']),
        fixed('rv:uncastPolicy', 'rv:UncastNotCounted'),
        count('rv:passNumerator', 1, 1000),
        count('rv:passDenominator', 1, 1000),
        choice('rv:invalidationPolicy', ['rv:NoBallotInvalidation', 'rv:DeclaredInvalidationDecision']),
      ],
    },
    {
      iri: 'https://rezics.com/definition/charter-revision-v1/holder-revision-shape',
      properties: [
        ...revisionCore,
        { path: 'rdf:type', hasValue: 'rv:HolderCharterRevision' },
        choice('rv:mandateRule', ['rv:DesignatedRepresentative', 'rv:AnyAdmittedRepresentative',
          'rv:KOfNApproval', 'rv:InternalDecision']),
        choice('rv:aggregationMode', ['rv:WholeBallot', 'rv:ProportionalSplit']),
      ],
      or: [
        [
          { path: 'rv:mandateRule', hasValue: 'rv:KOfNApproval' },
          count('rv:approvalThreshold', 1, 64),
        ],
        ...(['rv:DesignatedRepresentative', 'rv:AnyAdmittedRepresentative', 'rv:InternalDecision'] as const)
          .map(rule => [
            { path: 'rv:mandateRule' as const, hasValue: rule },
            { path: 'rv:approvalThreshold' as const, maxCount: 0 },
          ]),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
