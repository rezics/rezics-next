import { expect, test } from 'bun:test';
import type { FilterDocument } from '../../../model/definitions/filter-document-v1.ts';
import { conceptWorksFilter } from '../src/modules/concept-page/contract.ts';
import { QueryRejected } from '../src/modules/query/compile.ts';
import { homeAvailable, homeFeedConditions } from '../src/modules/saved-filter/feed.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const refusal = (run: () => unknown) => {
  try { run(); } catch (error) {
    if (error instanceof QueryRejected) return error.refusal;
    throw error;
  }
  return null;
};

test('G-912 a match-any Concept page pins to Home, and a wider one is still refused', () => {
  const page = id(1), added = id(2), other = id(3), dropped = id(4);
  const matched = conceptWorksFilter(page, [added, other], [], 'any') as FilterDocument;
  expect(homeAvailable(matched)).toBe(true);
  expect(homeFeedConditions(matched)).toEqual({ concepts: [added, other], languages: [], realms: [],
    requiredConcept: page });
  const excluded = conceptWorksFilter(page, [added], [dropped], 'any') as FilterDocument;
  expect(homeFeedConditions(excluded)).toEqual({ concepts: [added], languages: [], realms: [],
    requiredConcept: page, excludedConcepts: [dropped] });
  // Match all of the page and an addition is still one Condition Home cannot show.
  expect(refusal(() => homeFeedConditions(conceptWorksFilter(page, [added], [], 'all') as FilterDocument)))
    .toBe('unsupported_query_shape');
  // The page, two additions and an exclusion are four Concepts, past Home's three.
  const wide = conceptWorksFilter(page, [added, other], [dropped], 'any') as FilterDocument;
  expect(refusal(() => homeFeedConditions(wide))).toBe('query_budget_exceeded');
  expect(homeAvailable(wide)).toBe(false);
});
