import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workTypeV3Declaration = {
  id: 'work-type-v3',
} as const satisfies TurtleDeclaration;

export const workTypeV3Profile = parseTurtleProfile(
  workTypeV3Declaration.id,
  readFileSync(new URL('./work-type-v3.ttl', import.meta.url), 'utf8'),
  workTypeV3Declaration,
);
