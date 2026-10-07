import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const statementDecisionDeclaration = {
  id: 'statement-decision-v1',
  canonical: {
    slot: { types: ['rv:DecisionSlot'] },
    decision: { types: ['rv:StatementDecision'] },
  },
} as const satisfies TurtleDeclaration;

export const statementDecisionProfile = parseTurtleProfile(
  statementDecisionDeclaration.id,
  readFileSync(new URL('./statement-decision-v1.ttl', import.meta.url), 'utf8'),
  statementDecisionDeclaration,
);
