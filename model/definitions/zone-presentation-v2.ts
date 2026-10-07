import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const zonePresentationV2Declaration = {
  id: 'zone-presentation-v2',
} as const satisfies TurtleDeclaration;

export const zonePresentationProfile = parseTurtleProfile(
  zonePresentationV2Declaration.id,
  readFileSync(new URL('./zone-presentation-v2.ttl', import.meta.url), 'utf8'),
  zonePresentationV2Declaration,
);
