import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realmPolicySelectionDeclaration = {
  id: 'realm-policy-selection-v1',
} as const satisfies TurtleDeclaration;

export const realmPolicySelectionProfile = parseTurtleProfile(
  realmPolicySelectionDeclaration.id,
  readFileSync(new URL('./realm-policy-selection-v1.ttl', import.meta.url), 'utf8'),
  realmPolicySelectionDeclaration,
);
