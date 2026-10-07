import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationDirectDecisionDeclaration = {
  id: 'classification-direct-decision-v1',
  canonical: {
    application: { types: ['rv:ClassificationApplication'] },
    decision: { types: ['rv:ClassificationDecision'] },
  },
  binding: {
    required: [
      'work', 'main', 'sense', 'sense-revision', 'context', 'context-kind', 'application', 'decision',
      'slot', 'proposer', 'decider', 'outcome',
    ],
    optional: ['realm', 'context-revision', 'predecessor'],
    roles: ['work', 'main', 'sense', 'context', 'application', 'decision'],
    demandedBy: ['rv:ClassificationApplication', 'rv:ClassificationDecision'],
  },
} as const satisfies TurtleDeclaration;

export const classificationDirectDecisionProfile = parseTurtleProfile(
  'classification-direct-decision-v1',
  readFileSync(new URL('./classification-direct-decision-v1.ttl', import.meta.url), 'utf8'),
  classificationDirectDecisionDeclaration,
);
