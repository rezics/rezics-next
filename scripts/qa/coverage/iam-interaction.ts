import type { CaseDeclarations } from './declaration.ts';

export const iamInteractionCases: CaseDeclarations = {
  IAM18: [{ tier: 'integration', file: 'tests/qa/integration/access-interaction-api.test.ts',
    name: 'IAM18: mute, interaction block and resource exclusion keep separate owners and effects' },
  { tier: 'integration', file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'IAM18/SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging, Access mute and author switch' }],
};
