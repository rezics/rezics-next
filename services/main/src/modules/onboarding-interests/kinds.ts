export { interestKinds, interestSources, matchingActivityKinds, matchingWorkKinds,
  type InterestSources } from '../work/work-kinds.ts';

import type { HomeInterestKind } from './contract.ts';

/** Official Zone route segments are the publisher's stable catalogue choices.
 * Source-adopted classics and editorial software guides can lack a semantic
 * Work type; community Realms use their Works and accepted classifications. */
export const officialZoneInterests: Readonly<Record<string, HomeInterestKind>> = {
  fiction: 'books', books: 'books', mods: 'software', software: 'software',
  'ai-workshop': 'ai', kitchen: 'recipes',
};
