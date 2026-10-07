import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workKindDeclaration = {
  id: 'work-kind-v1',
} as const satisfies TurtleDeclaration;

/** A Work can carry several descriptive RDF types while retaining one Work
 * identity and one MainVersion. The command admits only its reviewed type set. */
export const workKindProfile = parseTurtleProfile(
  workKindDeclaration.id,
  readFileSync(new URL('./work-kind-v1.ttl', import.meta.url), 'utf8'),
  workKindDeclaration,
);
