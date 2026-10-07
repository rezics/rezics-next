import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationContextDeclaration = {
  id: 'classification-context-v1',
} as const satisfies TurtleDeclaration;

export const classificationContextProfile = parseTurtleProfile(
  'classification-context-v1',
  readFileSync(new URL('./classification-context-v1.ttl', import.meta.url), 'utf8'),
  classificationContextDeclaration,
);
