import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const spaceRealmV3Declaration = {
  id: 'space-realm-v3',
  canonical: {
    space: {
      types: ['rv:Space'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-realm-v3>',
      }],
    },
    realm: {
      types: ['rv:Realm'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-realm-v3>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const spaceRealmV3Profile = parseTurtleProfile(
  spaceRealmV3Declaration.id,
  readFileSync(new URL('./space-realm-v3.ttl', import.meta.url), 'utf8'),
  spaceRealmV3Declaration,
);
