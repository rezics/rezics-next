import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const textPublicationDeclaration = {
  id: 'text-publication-v1',
} as const satisfies TurtleDeclaration;

export const textPublicationProfile = parseTurtleProfile(
  textPublicationDeclaration.id,
  readFileSync(new URL('./text-publication-v1.ttl', import.meta.url), 'utf8'),
  textPublicationDeclaration,
);
