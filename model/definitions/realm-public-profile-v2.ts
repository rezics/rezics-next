import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

const definition = '<https://rezics.com/definition/realm-public-profile-v2>';

export const realmPublicV2Declaration = {
  id: 'realm-public-profile-v2',
  canonical: {
    revision: {
      types: ['rv:RealmPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: definition }],
    },
  },
} as const satisfies TurtleDeclaration;

export const realmPublicV2Profile = parseTurtleProfile(
  realmPublicV2Declaration.id,
  readFileSync(new URL('./realm-public-profile-v2.ttl', import.meta.url), 'utf8'),
  realmPublicV2Declaration,
);
