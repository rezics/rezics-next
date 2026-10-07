import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const protectionRevisionDeclaration = {
  id: 'protection-revision-v1',
  canonical: {
    protection: { types: ['rv:ProtectionRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const protectionRevisionProfile = parseTurtleProfile(
  protectionRevisionDeclaration.id,
  readFileSync(new URL('./protection-revision-v1.ttl', import.meta.url), 'utf8'),
  protectionRevisionDeclaration,
);
