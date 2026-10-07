import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const webSnapshotDeclaration = {
  id: 'web-snapshot-v1',
  canonical: {
    snapshot: { types: ['rv:WebSnapshot'] },
  },
} as const satisfies TurtleDeclaration;

export const webSnapshotProfile = parseTurtleProfile(
  webSnapshotDeclaration.id,
  readFileSync(new URL('./web-snapshot-v1.ttl', import.meta.url), 'utf8'),
  webSnapshotDeclaration,
);
