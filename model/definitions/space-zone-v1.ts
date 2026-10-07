import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const spaceZoneDeclaration = {
  id: 'space-zone-v1',
  canonical: {
    space: {
      types: ['rv:Space'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-zone-v1>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const spaceZoneProfile = parseTurtleProfile(
  spaceZoneDeclaration.id,
  readFileSync(new URL('./space-zone-v1.ttl', import.meta.url), 'utf8'),
  spaceZoneDeclaration,
);
