import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const spaceRealmV2Declaration = {
  id: 'space-realm-v2',
  canonical: {
    space: {
      types: ['rv:Space'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-realm-v2>',
      }],
    },
    realm: {
      types: ['rv:Realm'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-realm-v2>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const spaceRealmV2Profile = parseTurtleProfile(
  spaceRealmV2Declaration.id,
  readFileSync(new URL('./space-realm-v2.ttl', import.meta.url), 'utf8'),
  spaceRealmV2Declaration,
);
