// Integration files that need their own bootstrapped QA project (they replace
// dataset heads, replay outboxes from zero or need a fresh graph). Parallel Goal
// branches append entries; git's union merge driver keeps both sides (see
// .gitattributes), so add a comment line and a path line, never reorder.
export const isolatedIntegrationFileList = [
  // M6 replays reference suites that require fresh rating and catalogue inventories.
  'tests/qa/integration/g-856-wiki.test.ts',
  'tests/qa/integration/g-856-editorial.test.ts',
  'tests/qa/integration/g-856-position.test.ts',
  'tests/qa/integration/g-856-readers.test.ts',
  'tests/qa/integration/g-856-sessions.test.ts',
  'tests/qa/integration/g-856-library.test.ts',
  'tests/qa/integration/g-856-discovery.test.ts',
  'tests/qa/integration/g-856-series.test.ts',
  'tests/qa/integration/g-856-zones.test.ts',
  'tests/qa/integration/g-856-catalogue.test.ts',
  // Portable bundle imports assert the complete fresh Access rating inventory.
  'tests/qa/integration/g-854-library-bundle.test.ts',
  // G-724 consumes first-administrator configuration and needs empty owner/graph state.
  'tests/qa/integration/g-724-bootstrap.test.ts',
  // Global classification bootstrap exercises an empty graph and resets its own Context (G-380).
  'tests/qa/integration/classification-bootstrap.test.ts',
  // Read stability writes concurrently while the relay catches up (G-323).
  'tests/qa/integration/read-stability.test.ts',
  // Home feed replays the relay from zero and exercises private/disclosure fences.
  'tests/qa/integration/feed-home.test.ts',
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
  // Profile/library probes change disclosure, erasure and the dataset restore hold.
  'services/main/tests/profiles.integration.test.ts',
  // Person onboarding and vanity claims need a fresh Agent graph and Access owner.
  'tests/qa/integration/agent-handle.test.ts',
  // Directory assertions need an empty Realm population; scale probes inject raw heads and a global restore hold.
  'tests/qa/integration/realm-directory.test.ts',
  // Discovery refresh replays outboxes from zero and starts with no active population.
  'tests/qa/integration/discovery-refresh.test.ts',
  // Incremental discovery pins the exact initial Work population before appending writers.
  'tests/qa/integration/discovery-incremental.test.ts',
  // These readers bind whole-dataset populations or require matching graph/SQL owner histories.
  'tests/qa/integration/also-enjoyed.test.ts',
  'tests/qa/integration/authenticated-api-journey.test.ts',
  'tests/qa/integration/content-public-domain.test.ts',
  'tests/qa/integration/home-list-cards.test.ts',
  'tests/qa/integration/organization-publication-moderation.test.ts',
  'tests/qa/integration/public-search-cjk.test.ts',
  'tests/qa/integration/public-selection-oracle.test.ts',
  'tests/qa/integration/ranking-progress.test.ts',
  'tests/qa/integration/review-api.test.ts',
  'tests/qa/integration/search-chapter-book.test.ts',
  'tests/qa/integration/search-source-title.test.ts',
  'tests/qa/integration/wiki-realm-selection.test.ts',
  'tests/qa/integration/work-serial-projection.test.ts',
  // Previously qualified only on automatic retry; declare their fresh owner requirement up front.
  'tests/qa/integration/structure-relay.test.ts',
  'tests/qa/integration/main-selection-languages.test.ts',
  'tests/qa/integration/search-studio-chapter-content.test.ts',
  // The scale probe uses this bootstrapped project instead of provisioning a nested stack.
  'tests/qa/integration/growth-search-refresh.test.ts',
  // Global standing-rating cards must share their graph and Access population.
  'tests/qa/integration/search-card-fields.test.ts',
  // Confirmed fresh-project passes after shared graph/SQL history failures (G-408).
  'tests/qa/integration/search-card-rich.test.ts',
  'tests/qa/integration/search-title-body-native.test.ts',
  'tests/qa/integration/content-eligibility-order.test.ts',
  'tests/qa/integration/feed-reviews.test.ts',
  // G-401's assertions stay unchanged; the budget's population belongs to this file.
  'tests/qa/integration/feed-read-budget.test.ts',
  // Owner settlement and library discovery compare a complete fresh population.
  'tests/qa/integration/content-variant-order.test.ts',
  'tests/qa/integration/library-status.test.ts',
  // Home replays prior receipts; public paging requires coherent card owners.
  'tests/qa/integration/follows-authors.test.ts',
  'tests/qa/integration/paging-authority-search.test.ts',
  // Saved Filter tabs read Home's feed, which is global across the QA project's files.
  'tests/qa/integration/saved-filter.test.ts',
  // Continue across volumes seeds Home, whose relay replays prior receipts from zero (G-410).
  'tests/qa/integration/structure-book-volumes.test.ts',
  // These probes bind exact replay positions or a complete graph/owner population.
  'tests/qa/integration/g-825-structure-receipt-family.test.ts',
  'tests/qa/integration/g-585-script-folding.test.ts',
  // Relation history must use the same immutable object directory as its graph.
  'tests/qa/integration/g-905-catalogue.test.ts',
  // These probes finish or rank the complete graph population within fixed budgets.
  'tests/qa/integration/concept-page.test.ts',
  'tests/qa/integration/g-556-ranked-catalogue.test.ts',
  // Home's relay reads its complete retained outbox from sequence zero.
  'tests/qa/integration/g-542-endpoints.test.ts',
  // Retained relation definitions must use the object directory that owns their graph revisions.
  'tests/qa/integration/g-831-relations.test.ts',
  'tests/qa/integration/g-832-lexicon.test.ts',
  'tests/qa/integration/g-840-catalogue.test.ts',
  'tests/qa/integration/g-894-progress-summary.test.ts',
  // Release traversal probes own their complete global publication and owner inventory.
  'tests/qa/integration/g-851-release-query.test.ts',
  // Suitability's complete resource reads require matching global Rating Context and Access histories.
  'tests/qa/integration/g-897-suitability.test.ts',
] as const;

/** Delta proofs require the product assembler, whose raw update endpoint is closed. */
export const commandOnlyIntegrationFiles: ReadonlySet<string> = new Set([
  'tests/qa/integration/growth-search-refresh.test.ts',
]);
