// Integration files that need their own bootstrapped QA project (they replace
// dataset heads, replay outboxes from zero or need a fresh graph). Parallel Goal
// branches append entries; git's union merge driver keeps both sides (see
// .gitattributes), so add a comment line and a path line, never reorder.
export const isolatedIntegrationFileList = [
  // Work read probes cut over classification and replace the dataset epoch.
  'services/main/tests/work-read.integration.test.ts',
  // Realm read probes change public disclosure, erasure and the restore hold.
  'services/main/tests/realm-read.integration.test.ts',
  // Management read probes hide a Realm and toggle its restore hold.
  'services/main/tests/management-read.integration.test.ts',
  'tests/qa/integration/validation-command.test.ts',
  'tests/qa/integration/validation-cross-profile.test.ts',
  // MODEL22 deliberately replaces the dataset's model generation head to
  // prove an in-flight semantic command is fenced. Later writers require the
  // bootstrap generation, so this file owns a fresh graph.
  'tests/qa/integration/semantic-generation.test.ts',
  'tests/qa/integration/search-statement-query.test.ts',
  'tests/qa/integration/event-time.test.ts',
  'tests/qa/integration/access-org-realm-move-api.test.ts',
  'tests/qa/integration/theme-activation-api.test.ts',
  'tests/qa/integration/owner-operations.test.ts',
  'tests/qa/integration/owner-relay-gap.test.ts',
  'tests/qa/integration/owner-outbox-recovery.test.ts',
  'tests/qa/integration/sys-receipt-relay-gap.test.ts',
  'tests/qa/integration/rating-release-target.test.ts',
  'tests/qa/integration/content-publication-native.test.ts',
  'tests/qa/integration/context-statement-cases.test.ts',
  'tests/qa/integration/erasure-api.test.ts',
  'tests/qa/integration/erasure-published-search.test.ts',
  'tests/qa/integration/hub-api.test.ts',
  'tests/qa/integration/judgment-api.test.ts',
  'tests/qa/integration/protection-content-api.test.ts',
  'tests/qa/integration/protection-work-api.test.ts',
  'tests/qa/integration/public-search-scale.test.ts',
  'tests/qa/integration/recommendation-context.test.ts',
  'tests/qa/integration/realm-reply-api.test.ts',
  'tests/qa/integration/source-graph-projection.test.ts',
  'tests/qa/integration/source-authenticated-api.test.ts',
  'tests/qa/integration/source-field-cost.test.ts',
  'tests/qa/integration/source-field.test.ts',
  'tests/qa/integration/source-support-attach.test.ts',
  'tests/qa/integration/translated-work-links.test.ts',
  'tests/qa/integration/web-auth-bootstrap.test.ts',
  'tests/qa/integration/work-address-api.test.ts',
  'tests/qa/integration/work-derivation.test.ts',
  // Discovery probes cut over classification and toggle the dataset restore hold.
  'tests/qa/integration/discovery-projection.test.ts',
] as const;
