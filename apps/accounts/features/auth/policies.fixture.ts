import type { PolicyVersion } from './policies.ts';

/** Story data shaped like Account's `GET /api/account/policies`; the digests are not any real text's. */
export const policyFixture: PolicyVersion[] = [
  { policyId: 'terms', source: 'docs/legal/terms-of-service.md', effectiveDate: '2026-10-01',
    versionDigest: 'a'.repeat(64) },
  { policyId: 'privacy', source: 'docs/legal/privacy-policy.md', effectiveDate: '2026-10-01',
    versionDigest: 'b'.repeat(64) },
];
