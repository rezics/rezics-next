import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const proposalDeclaration = {
  id: 'proposal-v1',
  canonical: {
    proposal: { types: ['rv:Proposal'] },
    revision: { types: ['rv:ProposalRevision'] },
    execution: { types: ['rv:ProposalExecution'] },
  },
} as const satisfies TurtleDeclaration;

export const proposalProfile = parseTurtleProfile(
  proposalDeclaration.id,
  readFileSync(new URL('./proposal-v1.ttl', import.meta.url), 'utf8'),
  proposalDeclaration,
);
