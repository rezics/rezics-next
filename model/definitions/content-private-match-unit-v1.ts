import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contentPrivateMatchUnitDeclaration = {
  id: 'content-private-match-unit-v1',
  canonical: {
    state: { types: ['rv:ContentPrivateSearchState'] },
    projection: { types: ['rv:ContentPrivateProjection'] },
  },
} as const satisfies TurtleDeclaration;

export const contentPrivateMatchUnitProfile = parseTurtleProfile(
  contentPrivateMatchUnitDeclaration.id,
  readFileSync(new URL('./content-private-match-unit-v1.ttl', import.meta.url), 'utf8'),
  contentPrivateMatchUnitDeclaration,
);
