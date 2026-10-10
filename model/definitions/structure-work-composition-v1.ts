import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const structureWorkCompositionDeclaration = {
  id: 'structure-work-composition-v1',
  canonical: {
    part: {
      types: ['rv:WorkPart'],
    },
  },
} as const satisfies TurtleDeclaration;

export const structureWorkCompositionProfile = parseTurtleProfile(
  structureWorkCompositionDeclaration.id,
  readFileSync(new URL('./structure-work-composition-v1.ttl', import.meta.url), 'utf8'),
  structureWorkCompositionDeclaration,
);
