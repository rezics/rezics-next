import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const webPublicationDeclaration = {
  id: 'web-publication-v1',
} as const satisfies TurtleDeclaration;

export const webPublicationProfile = parseTurtleProfile(
  webPublicationDeclaration.id,
  readFileSync(new URL('./web-publication-v1.ttl', import.meta.url), 'utf8'),
  webPublicationDeclaration,
);
