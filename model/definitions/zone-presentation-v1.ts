import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const zonePresentationDeclaration = {
  id: 'zone-presentation-v1',
} as const satisfies TurtleDeclaration;

export const zonePresentationProfile = parseTurtleProfile(
  zonePresentationDeclaration.id,
  readFileSync(new URL('./zone-presentation-v1.ttl', import.meta.url), 'utf8'),
  zonePresentationDeclaration,
);
