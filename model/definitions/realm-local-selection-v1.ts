import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realmLocalSelectionDeclaration = {
  id: 'realm-local-selection-v1',
} as const satisfies TurtleDeclaration;

export const realmLocalSelectionProfile = parseTurtleProfile(
  realmLocalSelectionDeclaration.id,
  readFileSync(new URL('./realm-local-selection-v1.ttl', import.meta.url), 'utf8'),
  realmLocalSelectionDeclaration,
);
