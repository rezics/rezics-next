import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });
const units = (path: Term, minInclusive: number) =>
  one(path, { datatype: 'xsd:integer', minInclusive, maxInclusive: 1000000 });
const zeroUnits: PropertyDefinition = { path: 'rv:countedUnits', hasValue: '0', maxCount: 1 };

export const ballotProfile = {
  id: 'ballot-v1',
  comments: [
    'One Ballot component per poll and frozen seat (root entitlement or active leaf);',
    'every representative, proxy and authority path operates the same component through',
    'its expected head. Revisions are immutable: cast, withdrawn or invalidated. Shares',
    'conserve exactly the seat units under the holder charter aggregation mode.',
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
      iri: 'https://rezics.com/definition/ballot-v1/ballot-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Ballot' },
        link('rv:poll', 'rv:Poll'),
        link('rv:seat', 'rv:VotingSeat'),
        link('rv:sourceEntitlement', 'rv:SourceEntitlement'),
        link('rv:ballotHead', 'rv:BallotRevision'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/ballot-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:BallotRevision' },
        link('rv:ballot', 'rv:Ballot'),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:BallotRevision' },
        link('rv:pollOpening', 'rv:PollOpening'),
        { path: 'rv:holderCharter', maxCount: 1, class: 'rv:HolderCharterRevision' },
        one('rv:ballotAvailability', { in: ['rv:BallotCast', 'rv:BallotWithdrawn', 'rv:BallotInvalidated'] }),
        one('rv:castRoute', { in: ['rv:HolderCast', 'rv:ProxyCast', 'rv:HolderOverride'] }),
        { path: 'rv:proxyRoute', maxCount: 1, class: 'rv:ProxyRouteRevision' },
        { path: 'rv:mandateApproval', class: 'rv:MandateApproval' },
        { path: 'rv:internalResolution', maxCount: 1, class: 'rv:PollResolution' },
        one('rv:ballotDigest', { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' }),
        units('rv:countedUnits', 0),
        one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' }),
        one('rv:submittedAt', { datatype: 'xsd:dateTime' }),
      ],
      or: [
        [
          { path: 'rv:ballotAvailability', hasValue: 'rv:BallotCast' },
          { path: 'rv:ballotShare', minCount: 1, class: 'rv:BallotShare' },
          units('rv:countedUnits', 1),
          { path: 'rv:invalidationDecision', maxCount: 0 },
        ],
        [
          { path: 'rv:ballotAvailability', hasValue: 'rv:BallotWithdrawn' },
          { path: 'rv:ballotShare', maxCount: 0 },
          zeroUnits,
          { path: 'rv:invalidationDecision', maxCount: 0 },
        ],
        [
          { path: 'rv:ballotAvailability', hasValue: 'rv:BallotInvalidated' },
          { path: 'rv:ballotShare', maxCount: 0 },
          zeroUnits,
          link('rv:invalidationDecision', 'rv:BallotInvalidation'),
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/ballot-v1/share-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:BallotShare' },
        link('rv:ballotRevision', 'rv:BallotRevision'),
        link('rv:option', 'rv:PollOption'),
        units('rv:shareUnits', 1),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
