import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workMetadataDetailsDeclaration = {
  id: 'work-metadata-details-v1',
  canonical: {
    component: { types: ['rv:WorkMetadataComponent'] },
    revision: { types: ['rv:WorkMetadataRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const workMetadataDetailsProfile = parseTurtleProfile(
  workMetadataDetailsDeclaration.id,
  readFileSync(new URL('./work-metadata-details-v1.ttl', import.meta.url), 'utf8'),
  workMetadataDetailsDeclaration,
);
