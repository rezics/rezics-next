import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workMetadataV2Declaration = {
  id: 'work-metadata-v2',
} as const satisfies TurtleDeclaration;

export const workMetadataV2Profile = parseTurtleProfile(
  workMetadataV2Declaration.id,
  readFileSync(new URL('./work-metadata-v2.ttl', import.meta.url), 'utf8'),
  workMetadataV2Declaration,
);
