import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationDirectDecisionDeclaration = {
  id: 'classification-direct-decision-v1',
} as const satisfies TurtleDeclaration;

export const classificationDirectDecisionProfile = parseTurtleProfile(
  'classification-direct-decision-v1',
  readFileSync(new URL('./classification-direct-decision-v1.ttl', import.meta.url), 'utf8'),
  classificationDirectDecisionDeclaration,
);
