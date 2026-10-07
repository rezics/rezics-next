import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const correctionDecisionDeclaration = {
  id: 'correction-decision-v1',
  canonical: {
    decision: { types: ['rv:CorrectionDecision'] },
    application: { types: ['rv:CorrectionApplication'] },
  },
} as const satisfies TurtleDeclaration;

export const correctionDecisionProfile = parseTurtleProfile(
  correctionDecisionDeclaration.id,
  readFileSync(new URL('./correction-decision-v1.ttl', import.meta.url), 'utf8'),
  correctionDecisionDeclaration,
);
