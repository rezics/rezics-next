import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const nameRegistryCleanupDeclaration = {
  id: 'name-registry-cleanup-v1',
  canonical: {
    cleaned: { types: ['rv:RetiredNameProjection'] },
  },
} as const satisfies TurtleDeclaration;

export const nameRegistryCleanupProfile = parseTurtleProfile(
  nameRegistryCleanupDeclaration.id,
  readFileSync(new URL('./name-registry-cleanup-v1.ttl', import.meta.url), 'utf8'),
  nameRegistryCleanupDeclaration,
);
