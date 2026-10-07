import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const charterRevisionDeclaration = {
  id: 'charter-revision-v1',
  canonical: {
    charter: { types: ['rv:VotingCharter'] },
    'electorate-revision': { types: ['rv:ElectorateCharterRevision'] },
    'holder-revision': { types: ['rv:HolderCharterRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const charterRevisionProfile = parseTurtleProfile(
  charterRevisionDeclaration.id,
  readFileSync(new URL('./charter-revision-v1.ttl', import.meta.url), 'utf8'),
  charterRevisionDeclaration,
);
