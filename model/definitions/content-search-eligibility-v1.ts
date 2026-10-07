import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contentSearchEligibilityDeclaration = {
  id: 'content-search-eligibility-v1',
  canonical: {
    decision: {
      types: ['rv:ContentSearchEligibilityDecision'],
      when: [{
        path: 'rv:modelRevision',
        value: '<https://rezics.com/definition/content-search-eligibility-v1>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const contentSearchEligibilityProfile = parseTurtleProfile(
  contentSearchEligibilityDeclaration.id,
  readFileSync(new URL('./content-search-eligibility-v1.ttl', import.meta.url), 'utf8'),
  contentSearchEligibilityDeclaration,
);
