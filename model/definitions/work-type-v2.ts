import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workTypeV2Declaration = {
  id: 'work-type-v2',
} as const satisfies TurtleDeclaration;

/** Type replacement admits games while old work-type-v1 payloads remain valid. */
export const workTypeV2Profile = parseTurtleProfile(
  workTypeV2Declaration.id,
  readFileSync(new URL('./work-type-v2.ttl', import.meta.url), 'utf8'),
  workTypeV2Declaration,
);
