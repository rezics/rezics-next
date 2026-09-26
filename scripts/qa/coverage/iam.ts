import type { CaseDeclarations } from './declaration.ts';

export const iamCases: CaseDeclarations = {
  IAM01: [{
    tier: 'integration',
    file: 'services/main/tests/acting-context.integration.test.ts',
    name: 'IAM01/IAM03/IAM04: Account and Access check explicit Agents without pooling or tab state',
  }],
  IAM03: [{
    tier: 'integration',
    file: 'services/main/tests/acting-context.integration.test.ts',
    name: 'IAM01/IAM03/IAM04: Account and Access check explicit Agents without pooling or tab state',
  }],
  IAM06: [{
    tier: 'integration',
    file: 'tests/qa/integration/access-membership-api.test.ts',
    name: 'IAM06: Org/Realm leave and rejoin fence dependent grants but retain bans',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/access-private-membership-api.test.ts',
    name: 'IAM06/IAM10/IAM33/IAM34: private membership binds exact direct, group and role authority',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/access-org-realm-api.test.ts',
    name: 'IAM23/IAM24/IAM06: independent Org/Realm participation requires two exact authorities',
  }, {
    tier: 'fault/recovery',
    file: 'services/main/tests/access-pitr.integration.test.ts',
    name: 'OPS03/IAM07/IAM06/IAM23/IAM24/IAM25/IAM26: archived Access WAL restores exact authority and participation (partial)',
  }],
  IAM10: [{
    tier: 'integration',
    file: 'tests/qa/integration/authenticated-api-journey.test.ts',
    name: 'IAM01/IAM10/IAM21/MODEL01/MODEL08/WORK01/WORK05/WORK09/BOOK04/CTX01/CTX02/SEARCH01: authenticated S2 API journey',
  }],
  IAM23: [{
    tier: 'integration',
    file: 'tests/qa/integration/access-org-realm-api.test.ts',
    name: 'IAM23/IAM24/IAM06: independent Org/Realm participation requires two exact authorities',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/organization-publication-moderation.test.ts',
    name: 'IAM23/IAM24: exact organization publication moderation and suspension affect only the admitted Realm',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/organization-publication-recovery.test.ts',
    name: 'IAM23/OPS03: isolated Access cuts and graph replay preserve one exact local organization rejection',
  }],
  IAM24: [{
    tier: 'integration',
    file: 'tests/qa/integration/access-org-realm-api.test.ts',
    name: 'IAM23/IAM24/IAM06: independent Org/Realm participation requires two exact authorities',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/access-managed-organization-api.test.ts',
    name: 'IAM24/IAM23/IAM06: explicit managed organization grants protect a real roster policy operation (partial)',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/access-org-realm-move-api.test.ts',
    name: 'IAM24/IAM06: atomic Org Realm moves bind exact authorities, paired history and bounded receipts',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/organization-publication-moderation.test.ts',
    name: 'IAM23/IAM24: exact organization publication moderation and suspension affect only the admitted Realm',
  }, {
    tier: 'fault/recovery',
    file: 'services/main/tests/access-pitr.integration.test.ts',
    name: 'OPS03/IAM07/IAM06/IAM23/IAM24/IAM25/IAM26: archived Access WAL restores exact authority and participation (partial)',
  }],
  IAM25: [{
    tier: 'integration',
    file: 'tests/qa/integration/access-eligible-org-member-set-api.test.ts',
    name: 'IAM25: B grants the exact eligible A-member set; P exercises it as P',
  }, {
    tier: 'fault/recovery',
    file: 'services/main/tests/access-pitr.integration.test.ts',
    name: 'OPS03/IAM07/IAM06/IAM23/IAM24/IAM25/IAM26: archived Access WAL restores exact authority and participation (partial)',
  }],
  IAM26: [{
    tier: 'integration',
    file: 'tests/qa/integration/access-representation-api.test.ts',
    name: 'IAM26: exact P-to-A mandate and B-to-A grant change only B roster with private P proof',
  }, {
    tier: 'fault/recovery',
    file: 'services/main/tests/access-pitr.integration.test.ts',
    name: 'OPS03/IAM07/IAM06/IAM23/IAM24/IAM25/IAM26: archived Access WAL restores exact authority and participation (partial)',
  }],
};
