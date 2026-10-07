import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const spaceRealmDeclaration = {
  id: 'space-realm-v1',
  canonical: {
    space: {
      types: ['<https://rezics.com/vocab/Space>'],
    },
    realm: {
      types: ['<https://rezics.com/vocab/Realm>'],
    },
  },
} as const satisfies TurtleDeclaration;

export const spaceRealmProfile = parseTurtleProfile(
  spaceRealmDeclaration.id,
  readFileSync(new URL('./space-realm-v1.ttl', import.meta.url), 'utf8'),
  spaceRealmDeclaration,
);
