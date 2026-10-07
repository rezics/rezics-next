import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workMetadataDeclaration = {
  id: 'work-metadata-v1',
  canonical: {
    work: { types: ['schema:CreativeWork'] },
    'main-version': { types: ['rv:MainVersion'] },
  },
} as const satisfies TurtleDeclaration;

export const workMetadataProfile = parseTurtleProfile(
  workMetadataDeclaration.id,
  readFileSync(new URL('./work-metadata-v1.ttl', import.meta.url), 'utf8'),
  workMetadataDeclaration,
);
