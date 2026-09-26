import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });

export const ballotMandateApprovalProfile = {
  id: 'ballot-mandate-approval-v1',
  comments: [
    'One immutable k-of-n approval for one exact candidate ballot digest, which binds',
    'poll, seat, opening snapshot, holder charter, choice/distribution, expected ballot',
    'revision and mandate policy revision. The opaque approver slot derives from the',
    'private Access principal, so personas of one principal cannot approve twice.',
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
      iri: 'https://rezics.com/definition/ballot-mandate-approval-v1/approval-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MandateApproval' },
        link('rv:poll', 'rv:Poll'),
        link('rv:seat', 'rv:VotingSeat'),
        link('rv:pollOpening', 'rv:PollOpening'),
        link('rv:holderCharter', 'rv:HolderCharterRevision'),
        one('rv:mandatePolicyRevision', { nodeKind: 'sh:IRI' }),
        one('rv:candidateDigest', { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' }),
        { path: 'rv:expectedBallotRevision', maxCount: 1, class: 'rv:BallotRevision' },
        one('rv:approverSlot', { nodeKind: 'sh:IRI' }),
        one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' }),
        one('rv:approvedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
