import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });
const digest = (path: Term) => one(path, { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' });
const operation = one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' });
const notExecuted = (state: Term): PropertyDefinition[] =>
  [{ path: 'rv:proposalState', hasValue: state }, { path: 'rv:proposalExecution', maxCount: 0 }];

export const proposalProfile = {
  id: 'proposal-v1',
  comments: [
    'Governance proposals bind one exact effect digest, target, required capability and',
    'expected target state. Execution needs a finalized adopting resolution for that',
    'revision and digest plus the body capability admitted by Access; one execution per',
    'resolution and effect. Passing a proposal grants its voters no authority.',
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
      iri: 'https://rezics.com/definition/proposal-v1/proposal-shape',
      canonical: { types: ['rv:Proposal'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Proposal' },
        one('rv:governingBody', { nodeKind: 'sh:IRI' }),
        link('rv:proposalHead', 'rv:ProposalRevision'),
        one('rv:proposalState', { in: ['rv:ProposalOpen', 'rv:ProposalAdopted', 'rv:ProposalRejected',
          'rv:ProposalExecuted', 'rv:ProposalWithdrawn'] }),
        { path: 'rv:proposalExecution', maxCount: 1, class: 'rv:ProposalExecution' },
      ],
      or: [
        [{ path: 'rv:proposalState', hasValue: 'rv:ProposalExecuted' },
          link('rv:proposalExecution', 'rv:ProposalExecution')],
        notExecuted('rv:ProposalOpen'),
        notExecuted('rv:ProposalAdopted'),
        notExecuted('rv:ProposalRejected'),
        notExecuted('rv:ProposalWithdrawn'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/proposal-v1/revision-shape',
      canonical: { types: ['rv:ProposalRevision'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ProposalRevision' },
        link('rv:proposal', 'rv:Proposal'),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ProposalRevision' },
        one('rv:ruleRevision', { nodeKind: 'sh:IRI' }),
        digest('rv:effectDigest'),
        one('rv:effectTarget', { nodeKind: 'sh:IRI' }),
        one('rv:effectCapability', { datatype: 'xsd:string', minLength: 3, maxLength: 128 }),
        digest('rv:expectedTargetState'),
        operation,
        one('rv:revisedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
    {
      iri: 'https://rezics.com/definition/proposal-v1/execution-shape',
      canonical: { types: ['rv:ProposalExecution'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ProposalExecution' },
        link('rv:proposalRevision', 'rv:ProposalRevision'),
        link('rv:pollResolution', 'rv:PollResolution'),
        digest('rv:effectDigest'),
        one('rv:effectTarget', { nodeKind: 'sh:IRI' }),
        digest('rv:expectedTargetState'),
        one('rv:resultingTargetRevision', { nodeKind: 'sh:IRI' }),
        operation,
        one('rv:executedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
