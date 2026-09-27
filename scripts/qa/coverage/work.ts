import type { CaseDeclarations } from './declaration.ts';

export const workCases: CaseDeclarations = {
  WORK01: [{
    tier: 'integration',
    file: 'tests/qa/integration/web-auth-bootstrap.test.ts',
    name: 'IAM01/WORK01: authenticated metadata-only Work has an empty Main Version',
  }, {
    tier: 'e2e',
    file: 'apps/web/tests/authenticated-create.e2e.ts',
    name: 'WORK01: authenticated member creates a metadata-only Work with an empty Main Version',
  }],
  WORK02: [{
    tier: 'integration',
    file: 'tests/qa/integration/native-variants.test.ts',
    name: 'WORK02: two same-language native variants keep one Main spine and sparse reader choice',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/translated-work-links.test.ts',
    name: 'WORK02: independent translated Works retain exact and unresolved source provenance',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/translated-work-links.test.ts',
    name: 'WORK02: newer fixed releases inherit no translation coverage or official authorization, and metadata localization keeps content language',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/translated-work-recovery.test.ts',
    name: 'WORK02/OPS03: isolated graph loss restores exact translated Work links from retained events',
  }],
  WORK03: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-selection-oracle.test.ts',
    name: 'CTX02/CTX03/WORK03/SEARCH07/SEARCH19: joined decisions and Realm selection refresh only affected roots',
  }],
  WORK05: [{
    tier: 'integration',
    file: 'tests/qa/integration/authenticated-api-journey.test.ts',
    name: 'IAM01/IAM10/IAM21/MODEL01/MODEL08/WORK01/WORK05/WORK09/BOOK04/CTX01/CTX02/SEARCH01: authenticated S2 API journey',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/fixed-release-recovery.test.ts',
    name: 'MODEL01/WORK05/OPS03/LIVE10: graph loss restores the admitted fixed release, external links and exact bytes',
  }],
  WORK09: [{
    tier: 'integration',
    file: 'tests/qa/integration/content-publication-native.test.ts',
    name: 'WORK09/WORK10/SEARCH03/SEARCH19: Content CAS, private drafts and exact public search',
  }],
};
