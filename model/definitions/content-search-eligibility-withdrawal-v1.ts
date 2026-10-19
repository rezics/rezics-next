import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contentSearchEligibilityWithdrawalDeclaration = {
  id: 'content-search-eligibility-withdrawal-v1',
  canonical: {
    decision: {
      types: ['rv:ContentSearchEligibilityWithdrawalDecision'],
      when: [{
        path: 'rv:modelRevision',
        value: '<https://rezics.com/definition/content-search-eligibility-withdrawal-v1>',
      }],
    },
  },
} as const satisfies TurtleDeclaration;

export const contentSearchEligibilityWithdrawalProfile = parseTurtleProfile(
  contentSearchEligibilityWithdrawalDeclaration.id,
  readFileSync(new URL('./content-search-eligibility-withdrawal-v1.ttl', import.meta.url), 'utf8'),
  contentSearchEligibilityWithdrawalDeclaration,
);
