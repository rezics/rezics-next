import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contentSearchEligibilityV2Declaration = {
  id: 'content-search-eligibility-v2',
  canonical: {
    decision: {
      types: ['rv:ContentSearchEligibilityDecision'],
      when: [{
        path: 'rv:modelRevision',
        value: '<https://rezics.com/definition/content-search-eligibility-v2>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const publicDomainContentSearchEligibilityProfile = parseTurtleProfile(
  contentSearchEligibilityV2Declaration.id,
  readFileSync(new URL('./content-search-eligibility-v2.ttl', import.meta.url), 'utf8'),
  contentSearchEligibilityV2Declaration,
);
