import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const firstPartyBundleDeclaration = {
  id: 'first-party-bundle-v1',
} as const satisfies TurtleDeclaration;

export const firstPartyBundleProfile = parseTurtleProfile(
  firstPartyBundleDeclaration.id,
  readFileSync(new URL('./first-party-bundle-v1.ttl', import.meta.url), 'utf8'),
  firstPartyBundleDeclaration,
);
