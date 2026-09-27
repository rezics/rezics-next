import type { CaseDeclarations } from './declaration.ts';

export const searchPrivatePagingCases: CaseDeclarations = {
  SEARCH16: [{ tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'IAM18/SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging, Access mute and author switch' },
  { tier: 'integration', file: 'tests/qa/integration/paging-authority-search.test.ts',
    name: 'SEARCH16: separate public HTTP pages re-read Jena and restart after Access narrowing, graph movement or a stale index-generation cursor' }],
};
