import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workKindV2Declaration = {
  id: 'work-kind-v2',
} as const satisfies TurtleDeclaration;

/** New Work creation admits games while earlier work-kind-v1 shapes remain fixed. */
export const workKindV2Profile = parseTurtleProfile(
  workKindV2Declaration.id,
  readFileSync(new URL('./work-kind-v2.ttl', import.meta.url), 'utf8'),
  workKindV2Declaration,
);
