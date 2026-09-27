// Owner integration tests that live outside tests/qa/integration and join the
// integration tier. Parallel Goal branches append one path per line and git's
// union merge driver keeps both sides (see .gitattributes), so never reorder.
export const integrationGateFiles = [
  'services/account/tests/account.integration.test.ts',
  'services/account/tests/consent-revocation.integration.test.ts',
  'services/account/tests/oidc-authorization.integration.test.ts',
  'services/main/tests/access.integration.test.ts',
  'services/main/tests/account-assertion.integration.test.ts',
  'services/main/tests/acting-context.integration.test.ts',
  'services/main/tests/represented-work-proof.integration.test.ts',
  'services/main/tests/immutable-objects.integration.test.ts',
  'services/main/tests/search-read-lease.integration.test.ts',
  'services/main/tests/content-publication.integration.test.ts',
  'services/main/tests/content-projection.integration.test.ts',
  'services/main/tests/content-revision-read.integration.test.ts',
  'services/main/tests/context-schema.integration.test.ts',
  'services/main/tests/work-read.integration.test.ts',
  'services/main/tests/work-contents.integration.test.ts',
  'services/main/tests/work-activity.integration.test.ts',
  'services/main/tests/realm-read.integration.test.ts',
  'services/main/tests/management-read.integration.test.ts',
  'services/content/tests/core.integration.test.ts',
] as const;
