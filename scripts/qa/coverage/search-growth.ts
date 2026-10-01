import type { CaseDeclarations } from './declaration.ts';

export const searchGrowthCases: CaseDeclarations = {
  SEARCH07: [
    {
      tier: 'integration',
      file: 'tests/qa/integration/public-selection-oracle.test.ts',
      name: 'CTX02/CTX03/WORK03/SEARCH07/SEARCH19: joined decisions and Realm selection refresh only affected roots',
    },
    {
      tier: 'integration',
      file: 'tests/qa/integration/public-search-scale.test.ts',
      name: 'IAM18/SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging, Access mute and author switch',
    },
    {
      tier: 'unit',
      file: 'tests/qa/unit/search-budgets.test.ts',
      name: 'SEARCH07/SEARCH15/SEARCH18: qualified native writes avoid request-time corpus inventories',
    },
    {
      tier: 'integration',
      file: 'tests/qa/integration/growth-search-refresh.test.ts',
      name: 'SEARCH07: native selection refresh stays bounded across corpus, affected-root and author-degree growth',
    },
  ],
  SEARCH10: [
    {
      tier: 'integration',
      file: 'tests/qa/integration/search-grouped-native.test.ts',
      name: 'SEARCH01/SEARCH04/SEARCH10: public grouped route binds one lead and counts admitted facts at explicit grains',
    },
    {
      tier: 'fault/recovery',
      file: 'tests/qa/fault-recovery/search-candidate-overflow.test.ts',
      name: 'SEARCH02/SEARCH10: 513 real text hits with no eligible relation return a budget outcome',
    },
    {
      tier: 'unit',
      file: 'tests/qa/unit/search-grouped.test.ts',
      name: 'SEARCH10: grouped owner positions and relation budgets fail closed before exact facets',
    },
    {
      tier: 'unit',
      file: 'tests/qa/unit/search-route-budgets.test.ts',
      name: 'SEARCH10: query call and response-memory ceilings have typed HTTP budget outcomes',
    },
    {
      tier: 'integration',
      file: 'tests/qa/integration/growth-search-context.test.ts',
      name: 'SEARCH10: real Context interpretation reads stay bounded as consumers and inherited depth grow',
    },
    {
      tier: 'unit',
      file: 'tests/qa/unit/growth-search-route.test.ts',
      name: 'SEARCH10: grouped route byte exhaustion returns budget without exact count or facets',
    },
    {
      tier: 'unit',
      file: 'tests/qa/unit/growth-search-route.test.ts',
      name: 'SEARCH10: grouped route wall exhaustion returns unavailable without exact count or facets',
    },
  ],
};
