import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const ballotMandateApprovalDeclaration = {
  id: 'ballot-mandate-approval-v1',
  canonical: { approval: { types: ['rv:MandateApproval'] } },
} as const satisfies TurtleDeclaration;

export const ballotMandateApprovalProfile = parseTurtleProfile(
  ballotMandateApprovalDeclaration.id,
  readFileSync(new URL('./ballot-mandate-approval-v1.ttl', import.meta.url), 'utf8'),
  ballotMandateApprovalDeclaration,
);
