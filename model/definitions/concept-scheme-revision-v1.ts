import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const conceptSchemeRevisionDeclaration = {
  id: 'concept-scheme-revision-v1',
} as const satisfies TurtleDeclaration;

export const conceptSchemeRevisionProfile = parseTurtleProfile(
  conceptSchemeRevisionDeclaration.id,
  readFileSync(new URL('./concept-scheme-revision-v1.ttl', import.meta.url), 'utf8'),
  conceptSchemeRevisionDeclaration,
);
