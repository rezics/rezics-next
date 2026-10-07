import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const erasureGraphDeclaration = {
  id: 'erasure-graph-v1',
} as const satisfies TurtleDeclaration;

export const erasureGraphProfile = parseTurtleProfile(
  erasureGraphDeclaration.id,
  readFileSync(new URL('./erasure-graph-v1.ttl', import.meta.url), 'utf8'),
  erasureGraphDeclaration,
);
