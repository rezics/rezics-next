import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });
const count = (path: Term, minInclusive: number, maxInclusive: number) =>
  one(path, { datatype: 'xsd:integer', minInclusive, maxInclusive });
const digest = (path: Term) => one(path, { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' });
const at = (path: Term) => one(path, { datatype: 'xsd:dateTime' });
const operation = one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' });
const seatClasses = ['rv:PersonSeat', 'rv:OrganizationSeat', 'rv:CollectiveMemberSeat'] as const;
const state = (value: Term, opening: boolean, resolution: boolean): PropertyDefinition[] => [
  { path: 'rv:pollState', hasValue: value },
  opening ? link('rv:pollOpening', 'rv:PollOpening') : { path: 'rv:pollOpening', maxCount: 0 },
  resolution ? link('rv:pollResolution', 'rv:PollResolution') : { path: 'rv:pollResolution', maxCount: 0 },
];

export const pollSnapshotProfile = {
  id: 'poll-snapshot-v1',
  comments: [
    'Governance poll identity, exact question/options, electorate snapshot and opening.',
    'Source entitlements are issuance roots with an opaque per-electorate counting slot;',
    'Access keeps the private counting identity. Opening freezes question, charter,',
    'entitlements, activated allocation plans and proxy routes for the whole poll.',
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
      iri: 'https://rezics.com/definition/poll-snapshot-v1/poll-shape',
      canonical: { types: ['rv:Poll'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Poll' },
        one('rv:governingBody', { nodeKind: 'sh:IRI' }),
        link('rv:electorateCharter', 'rv:ElectorateCharterRevision'),
        link('rv:questionHead', 'rv:PollQuestionRevision'),
        { path: 'rv:proposalRevision', maxCount: 1, class: 'rv:ProposalRevision' },
        one('rv:pollState', { in: ['rv:PollDraft', 'rv:PollOpen', 'rv:PollClosed', 'rv:PollFinalized'] }),
        { path: 'rv:electorateSnapshot', maxCount: 1, class: 'rv:ElectorateSnapshot' },
        { path: 'rv:pollOpening', maxCount: 1, class: 'rv:PollOpening' },
        { path: 'rv:pollResolution', maxCount: 1, class: 'rv:PollResolution' },
        { path: 'rv:closedAt', maxCount: 1, datatype: 'xsd:dateTime' },
      ],
      or: [
        state('rv:PollDraft', false, false),
        state('rv:PollOpen', true, false),
        state('rv:PollClosed', true, false),
        state('rv:PollFinalized', true, true),
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-snapshot-v1/question-shape',
      canonical: { types: ['rv:PollQuestionRevision'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:PollQuestionRevision' },
        link('rv:poll', 'rv:Poll'),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:PollQuestionRevision' },
        { path: 'rv:question', minCount: 1, datatype: 'rdf:langString', minLength: 1, maxLength: 500 },
        digest('rv:questionDigest'),
        count('rv:optionCount', 2, 64),
        { path: 'rv:proposalRevision', maxCount: 1, class: 'rv:ProposalRevision' },
        operation,
        at('rv:revisedAt'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-snapshot-v1/option-shape',
      canonical: { types: ['rv:PollOption'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:PollOption' },
        link('rv:questionRevision', 'rv:PollQuestionRevision'),
        one('rv:optionKey', { datatype: 'xsd:string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
        one('rv:optionRole', { in: ['rv:ApproveOption', 'rv:RejectOption', 'rv:AbstainOption', 'rv:ChoiceOption'] }),
        { path: 'rv:label', minCount: 1, datatype: 'rdf:langString', minLength: 1, maxLength: 200 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-snapshot-v1/snapshot-shape',
      canonical: { types: ['rv:ElectorateSnapshot'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ElectorateSnapshot' },
        link('rv:poll', 'rv:Poll'),
        link('rv:electorateCharter', 'rv:ElectorateCharterRevision'),
        count('rv:entitlementCount', 1, 1000000),
        count('rv:issuedUnits', 1, 2000000000),
        digest('rv:snapshotDigest'),
        operation,
        at('rv:preparedAt'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-snapshot-v1/entitlement-shape',
      canonical: { types: ['rv:SourceEntitlement'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:SourceEntitlement' },
        { path: 'rdf:type', hasValue: 'rv:VotingSeat' },
        link('rv:electorateSnapshot', 'rv:ElectorateSnapshot'),
        link('rv:poll', 'rv:Poll'),
        one('rv:holder', { nodeKind: 'sh:IRI' }),
        one('rv:seatClass', { in: seatClasses }),
        one('rv:countingSlot', { nodeKind: 'sh:IRI' }),
        count('rv:issuedUnits', 1, 1000000),
        operation,
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-snapshot-v1/opening-shape',
      canonical: { types: ['rv:PollOpening'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:PollOpening' },
        link('rv:poll', 'rv:Poll'),
        link('rv:questionRevision', 'rv:PollQuestionRevision'),
        link('rv:electorateCharter', 'rv:ElectorateCharterRevision'),
        link('rv:electorateSnapshot', 'rv:ElectorateSnapshot'),
        digest('rv:allocationManifestDigest'),
        digest('rv:proxyRouteManifestDigest'),
        { path: 'rv:frozenProxyRoute', class: 'rv:ProxyRouteRevision' },
        count('rv:seatCount', 1, 2000000),
        count('rv:countedUnits', 1, 2000000000),
        digest('rv:openingDigest'),
        at('rv:closesAt'),
        at('rv:openedAt'),
        operation,
      ],
    },
  ],
} as const satisfies ProfileDefinition;
