import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contentMatchUnitDeclaration = {
  id: 'content-match-unit-v1',
} as const satisfies TurtleDeclaration;

export const contentMatchUnitProfile = parseTurtleProfile(
  contentMatchUnitDeclaration.id,
  readFileSync(new URL('./content-match-unit-v1.ttl', import.meta.url), 'utf8'),
  contentMatchUnitDeclaration,
);
