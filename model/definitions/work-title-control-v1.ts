import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workTitleControlDeclaration = {
  id: 'work-title-control-v1',
  canonical: { control: { types: ['rv:EditorialControlRevision'] } },
} as const satisfies TurtleDeclaration;

export const workTitleControlProfile = parseTurtleProfile(
  'work-title-control-v1',
  readFileSync(new URL('./work-title-control-v1.ttl', import.meta.url), 'utf8'),
  workTitleControlDeclaration,
);
