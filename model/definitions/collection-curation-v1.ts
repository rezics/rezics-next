import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const collectionCurationDeclaration = {
  id: 'collection-curation-v1',
  canonical: {
    collection: {
      types: ['rv:Collection'],
    },
    revision: {
      types: ['rv:CollectionRevision'],
    },
    definition: {
      types: ['rv:DynamicCollection'],
    },
    'definition-revision': {
      types: ['rv:DynamicCollectionRevision'],
    },
  },
} as const satisfies TurtleDeclaration;

export const collectionCurationProfile = parseTurtleProfile(
  collectionCurationDeclaration.id,
  readFileSync(new URL('./collection-curation-v1.ttl', import.meta.url), 'utf8'),
  collectionCurationDeclaration,
);
