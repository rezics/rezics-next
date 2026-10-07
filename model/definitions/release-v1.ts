import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const releaseDeclaration = {
  id: 'release-v1',
  canonical: {
    release: { types: ['rv:Release'] },
    revision: { types: ['rv:ReleaseRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const releaseProfile = parseTurtleProfile(
  releaseDeclaration.id,
  readFileSync(new URL('./release-v1.ttl', import.meta.url), 'utf8'),
  releaseDeclaration,
);
