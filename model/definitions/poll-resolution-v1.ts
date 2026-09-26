import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });
const count = (path: Term, minInclusive: number, maxInclusive: number) =>
  one(path, { datatype: 'xsd:integer', minInclusive, maxInclusive });
const digest = (path: Term) => one(path, { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' });
const operation = one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' });

export const pollResolutionProfile = {
  id: 'poll-resolution-v1',
  comments: [
    'Finalized poll resolutions and declared ballot invalidation decisions.',
    'Tallies count frozen seats and units of current ballot heads; mandate approval',
    'signatures are never seats. Uncast weight is reported but not counted.',
    'An invalidation cites its rule and evidence; it never rewrites ballot history.',
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
      iri: 'https://rezics.com/definition/poll-resolution-v1/resolution-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:PollResolution' },
        link('rv:poll', 'rv:Poll'),
        link('rv:pollOpening', 'rv:PollOpening'),
        link('rv:electorateCharter', 'rv:ElectorateCharterRevision'),
        link('rv:electorateSnapshot', 'rv:ElectorateSnapshot'),
        digest('rv:tallyDigest'),
        count('rv:countedSeats', 0, 2000000),
        count('rv:castUnits', 0, 2000000000),
        count('rv:abstainUnits', 0, 2000000000),
        count('rv:uncastUnits', 0, 2000000000),
        one('rv:quorumOutcome', { in: ['rv:QuorumMet', 'rv:QuorumNotMet'] }),
        one('rv:resolutionOutcome', { in: ['rv:ResolutionAdopted', 'rv:ResolutionRejected',
          'rv:ResolutionNoQuorum'] }),
        { path: 'rv:winningOption', maxCount: 1, class: 'rv:PollOption' },
        { path: 'rv:proposalRevision', maxCount: 1, class: 'rv:ProposalRevision' },
        { path: 'rv:effectDigest', maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
        operation,
        one('rv:finalizedAt', { datatype: 'xsd:dateTime' }),
      ],
      or: [
        [
          { path: 'rv:resolutionOutcome', hasValue: 'rv:ResolutionAdopted' },
          { path: 'rv:quorumOutcome', hasValue: 'rv:QuorumMet' },
          link('rv:winningOption', 'rv:PollOption'),
        ],
        [
          { path: 'rv:resolutionOutcome', hasValue: 'rv:ResolutionRejected' },
          { path: 'rv:quorumOutcome', hasValue: 'rv:QuorumMet' },
          { path: 'rv:winningOption', maxCount: 0 },
        ],
        [
          { path: 'rv:resolutionOutcome', hasValue: 'rv:ResolutionNoQuorum' },
          { path: 'rv:quorumOutcome', hasValue: 'rv:QuorumNotMet' },
          { path: 'rv:winningOption', maxCount: 0 },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-resolution-v1/tally-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:OptionTally' },
        link('rv:pollResolution', 'rv:PollResolution'),
        link('rv:option', 'rv:PollOption'),
        count('rv:tallyUnits', 0, 2000000000),
        count('rv:tallySeats', 0, 2000000),
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-resolution-v1/invalidation-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:BallotInvalidation' },
        link('rv:poll', 'rv:Poll'),
        link('rv:ballot', 'rv:Ballot'),
        link('rv:invalidatedRevision', 'rv:BallotRevision'),
        link('rv:electorateCharter', 'rv:ElectorateCharterRevision'),
        one('rv:ruleRevision', { nodeKind: 'sh:IRI' }),
        digest('rv:evidenceDigest'),
        operation,
        one('rv:decidedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
