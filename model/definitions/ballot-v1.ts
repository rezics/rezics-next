import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const ballotDeclaration = {
  id: 'ballot-v1',
  canonical: {
    ballot: { types: ['rv:Ballot'] },
    revision: { types: ['rv:BallotRevision'] },
    share: { types: ['rv:BallotShare'] },
  },
} as const satisfies TurtleDeclaration;

export const ballotProfile = parseTurtleProfile(
  ballotDeclaration.id,
  readFileSync(new URL('./ballot-v1.ttl', import.meta.url), 'utf8'),
  ballotDeclaration,
);
