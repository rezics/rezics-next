import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const textContributionDeclaration = {
  id: 'text-contribution-v1',
  canonical: {
    contribution: { types: ['rv:TextContribution'] },
  },
} as const satisfies TurtleDeclaration;

export const textContributionProfile = parseTurtleProfile(
  textContributionDeclaration.id,
  readFileSync(new URL('./text-contribution-v1.ttl', import.meta.url), 'utf8'),
  textContributionDeclaration,
);
