import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const collectionPublicNameDeclaration = {
  id: 'collection-public-name-v1',
  canonical: {
    revision: {
      types: ['rv:CollectionNameRevision'],
      when: [{
        path: 'rv:modelRevision',
        value: '<https://rezics.com/definition/collection-public-name-v1>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const collectionPublicNameProfile = parseTurtleProfile(
  collectionPublicNameDeclaration.id,
  readFileSync(new URL('./collection-public-name-v1.ttl', import.meta.url), 'utf8'),
  collectionPublicNameDeclaration,
);
