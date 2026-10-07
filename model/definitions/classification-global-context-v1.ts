import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationGlobalContextDeclaration = {
  id: 'classification-global-context-v1',
} as const satisfies TurtleDeclaration;

export const classificationGlobalContextProfile = parseTurtleProfile(
  'classification-global-context-v1',
  readFileSync(new URL('./classification-global-context-v1.ttl', import.meta.url), 'utf8'),
  classificationGlobalContextDeclaration,
);
