import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workMetadataDetailsV2Declaration = {
  id: 'work-metadata-details-v2',
  canonical: {
    component: { types: ['rv:EditionRecord'] },
    revision: { types: ['rv:WorkMetadataDetailsV2Revision'] },
  },
} as const satisfies TurtleDeclaration;

export const workMetadataDetailsV2Profile = parseTurtleProfile(
  workMetadataDetailsV2Declaration.id,
  readFileSync(new URL('./work-metadata-details-v2.ttl', import.meta.url), 'utf8'),
  workMetadataDetailsV2Declaration,
);
