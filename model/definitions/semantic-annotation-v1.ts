import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const semanticAnnotationDeclaration = {
  id: 'semantic-annotation-v1',
} as const satisfies TurtleDeclaration;

export const semanticAnnotationProfile = parseTurtleProfile(
  semanticAnnotationDeclaration.id,
  readFileSync(new URL('./semantic-annotation-v1.ttl', import.meta.url), 'utf8'),
  semanticAnnotationDeclaration,
);
