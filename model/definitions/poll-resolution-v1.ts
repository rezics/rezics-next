import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const pollResolutionDeclaration = {
  id: 'poll-resolution-v1',
  canonical: {
    resolution: { types: ['rv:PollResolution'] },
    tally: { types: ['rv:OptionTally'] },
    invalidation: { types: ['rv:BallotInvalidation'] },
  },
} as const satisfies TurtleDeclaration;

export const pollResolutionProfile = parseTurtleProfile(
  pollResolutionDeclaration.id,
  readFileSync(new URL('./poll-resolution-v1.ttl', import.meta.url), 'utf8'),
  pollResolutionDeclaration,
);
