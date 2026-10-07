import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationPropositionDeclaration = {
  id: 'classification-proposition-v1',
} as const satisfies TurtleDeclaration;

export const classificationPropositionProfile = parseTurtleProfile(
  'classification-proposition-v1',
  readFileSync(new URL('./classification-proposition-v1.ttl', import.meta.url), 'utf8'),
  classificationPropositionDeclaration,
);
