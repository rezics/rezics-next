import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const structureBookDeclaration = {
  id: 'structure-book-v1',
  canonical: {
    group: {
      types: ['rv:BookGroup'],
    },
  },
} as const satisfies TurtleDeclaration;

export const structureBookProfile = parseTurtleProfile(
  structureBookDeclaration.id,
  readFileSync(new URL('./structure-book-v1.ttl', import.meta.url), 'utf8'),
  structureBookDeclaration,
);
