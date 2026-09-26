import type { CaseDeclarations } from './declaration.ts';

/** Access policy decision, revocation and proof-handle cases (G-046). IAM18 still
 * lacks a presentation consumer and remains partial. */
const policyApi = 'tests/qa/integration/access-policy-api.test.ts';
const revocationApi = 'tests/qa/integration/access-revocation-api.test.ts';
const exclusion = 'IAM15/IAM16/IAM19: wiki policy revisions exclude Realm sets by basis, follow reorder and keep references purpose-bound';
const unresolved = 'IAM17/IAM22: unresolved or over-budget evidence stops first-applicable evaluation without weakening guards';

export const iamPolicyCases: CaseDeclarations = {
  IAM15: [{ tier: 'integration', file: policyApi, name: exclusion }],
  IAM16: [{ tier: 'integration', file: policyApi, name: exclusion }],
  IAM17: [{ tier: 'integration', file: policyApi, name: unresolved }],
  IAM19: [{ tier: 'integration', file: policyApi, name: exclusion }],
  IAM20: [{ tier: 'integration', file: policyApi,
    name: 'IAM20: decisions over an atomic grant/exclusion switch never combine two snapshots into an allow' }],
  IAM22: [{ tier: 'integration', file: policyApi, name: unresolved }],
  IAM29: [{ tier: 'integration', file: revocationApi,
    name: 'IAM29: revoking one of two independent grants keeps the other source and its provenance under mandatory guards' }],
  IAM33: [{ tier: 'integration', file: policyApi,
    name: 'IAM33: a proof handle is revalidated after revoke, expiry, leave/rejoin, role revision and actor switch' }],
};
