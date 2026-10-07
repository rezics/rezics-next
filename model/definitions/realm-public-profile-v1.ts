import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realmPublicProfileDeclaration = {
  id: 'realm-public-profile-v1',
  canonical: {
    'moderator-slot': { types: ['rv:RealmModeratorPublicChoice'] },
    revision: { types: ['rv:RealmPublicProfileRevision'] },
    'moderator-choice': { types: ['rv:RealmModeratorChoiceRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const realmPublicProfile = parseTurtleProfile(
  realmPublicProfileDeclaration.id,
  readFileSync(new URL('./realm-public-profile-v1.ttl', import.meta.url), 'utf8'),
  realmPublicProfileDeclaration,
);
