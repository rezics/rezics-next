import type { CaseDeclarations } from './declaration.ts';

export const searchPagingCases: CaseDeclarations = {
  SEARCH03: [{ tier: 'integration',
    file: 'tests/qa/integration/content-search-disclosure-native.test.ts',
    name: 'SEARCH03/SEARCH11: public owner values exclude private Context selections and spoiler Statements before score and facets' },
  { tier: 'integration', file: 'tests/qa/integration/content-search-disclosure-native.test.ts',
    name: 'SEARCH03/SEARCH11: hidden names and private avatars do not enter public search fields or counts' },
  { tier: 'integration', file: 'tests/qa/integration/search-disclosure-route.test.ts',
    name: 'SEARCH03/SEARCH11: public route excludes a private Context before hits, score and facets' },
  { tier: 'integration', file: 'tests/qa/integration/search-disclosure-route.test.ts',
    name: 'SEARCH03/SEARCH11: a public Work title matches while its private draft body changes no public field' }],
  SEARCH11: [{ tier: 'integration',
    file: 'tests/qa/integration/content-search-disclosure-native.test.ts',
    name: 'SEARCH03/SEARCH11: public owner values exclude private Context selections and spoiler Statements before score and facets' },
  { tier: 'integration', file: 'tests/qa/integration/content-search-disclosure-native.test.ts',
    name: 'SEARCH03/SEARCH11: hidden names and private avatars do not enter public search fields or counts' },
  { tier: 'integration', file: 'tests/qa/integration/search-disclosure-route.test.ts',
    name: 'SEARCH03/SEARCH11: public route excludes a private Context before hits, score and facets' },
  { tier: 'integration', file: 'tests/qa/integration/search-disclosure-route.test.ts',
    name: 'SEARCH03/SEARCH11: a public Work title matches while its private draft body changes no public field' }],
};
