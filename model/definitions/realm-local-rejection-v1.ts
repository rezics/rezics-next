import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realmLocalRejectionDeclaration = {
  id: 'realm-local-rejection-v1',
} as const satisfies TurtleDeclaration;

export const realmLocalRejectionProfile = parseTurtleProfile(
  realmLocalRejectionDeclaration.id,
  readFileSync(new URL('./realm-local-rejection-v1.ttl', import.meta.url), 'utf8'),
  realmLocalRejectionDeclaration,
);
