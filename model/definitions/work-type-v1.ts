import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workTypeDeclaration = {
  id: 'work-type-v1',
} as const satisfies TurtleDeclaration;

/** Type changes replace the structural rdf:types of one Work revision. Existing
 * work-kind-v1 remains the profile of earlier type declarations. */
export const workTypeProfile = parseTurtleProfile(
  workTypeDeclaration.id,
  readFileSync(new URL('./work-type-v1.ttl', import.meta.url), 'utf8'),
  workTypeDeclaration,
);
