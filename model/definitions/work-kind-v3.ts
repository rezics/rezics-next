import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workKindV3Declaration = {
  id: 'work-kind-v3',
} as const satisfies TurtleDeclaration;

export const workKindV3Profile = parseTurtleProfile(
  workKindV3Declaration.id,
  readFileSync(new URL('./work-kind-v3.ttl', import.meta.url), 'utf8'),
  workKindV3Declaration,
);
