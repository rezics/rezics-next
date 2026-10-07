import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const correctionProposalDeclaration = {
  id: 'correction-proposal-v1',
  canonical: {
    log: { types: ['rv:CorrectionLog'] },
    proposal: { types: ['rv:CorrectionProposal'] },
  },
} as const satisfies TurtleDeclaration;

export const correctionProposalProfile = parseTurtleProfile(
  correctionProposalDeclaration.id,
  readFileSync(new URL('./correction-proposal-v1.ttl', import.meta.url), 'utf8'),
  correctionProposalDeclaration,
);
