import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { rawSparqlIntegrationFiles, rawSparqlIntegrationScan, scanRawSparqlIntegrationFiles } from './isolated-integration-files.ts';

/** The scan parses every test file's imports: about five seconds alone, more beside other guards. */
const SCAN_TIMEOUT_MS = 60_000;

/** The initial ceiling unions the existing list with the callers missed in regression run 9,
 * including the 24 direct callers and roots that reach update helpers. It only shrinks as files
 * migrate their raw writes to commands; raw update blocks Work-name admission. */
const ceiling = new Set<string>([
  'tests/qa/integration/access-author.test.ts',
  'tests/qa/integration/access-avatar.test.ts',
  'tests/qa/integration/access-baseline.test.ts',
  'tests/qa/integration/access-managed-organization-api.test.ts',
  'tests/qa/integration/agent-profile.test.ts',
  'tests/qa/integration/also-enjoyed.test.ts',
  'tests/qa/integration/catalog-descriptions.test.ts',
  'tests/qa/integration/classification-bootstrap.test.ts',
  'tests/qa/integration/concept-page.test.ts',
  'tests/qa/integration/content-search-public-title-native.test.ts',
  'tests/qa/integration/content-zone-page.test.ts',
  'tests/qa/integration/content-zone-revision-delivery.test.ts',
  'tests/qa/integration/context-statement-cases.test.ts',
  'tests/qa/integration/discovery-continuous-writes.test.ts',
  'tests/qa/integration/discovery-projection-fixture.ts',
  'tests/qa/integration/discovery-projection.test.ts',
  'tests/qa/integration/discovery-rating-context-fixture.ts',
  'tests/qa/integration/discovery-rating-effects.test.ts',
  'tests/qa/integration/discovery-refresh.test.ts',
  'tests/qa/integration/erasure-source-reconcile.test.ts',
  'tests/qa/integration/event-query-bounds.test.ts',
  'tests/qa/integration/event-time.test.ts',
  'tests/qa/integration/export-api.test.ts',
  'tests/qa/integration/export-scoped-dependencies.test.ts',
  'tests/qa/integration/export-scoped-erased-rating.test.ts',
  'tests/qa/integration/feed-group-votes.test.ts',
  'tests/qa/integration/feed-home.test.ts',
  'tests/qa/integration/feed-read-stability.test.ts',
  'tests/qa/integration/feed-read-support.ts',
  'tests/qa/integration/feed-reviews.test.ts',
  'tests/qa/integration/follows-authors.test.ts',
  'tests/qa/integration/g-1001-work-cards.test.ts',
  'tests/qa/integration/g-1016-discovery-refresh.test.ts',
  'tests/qa/integration/g-1016-optional-hydration.test.ts',
  'tests/qa/integration/g-1019-unnamed-agent.test.ts',
  'tests/qa/integration/g-1033-discovery-refresh.test.ts',
  'tests/qa/integration/g-1042-ranking-followups.test.ts',
  'tests/qa/integration/g-1063-cost.test.ts',
  'tests/qa/integration/g-508-role-matrix.test.ts',
  'tests/qa/integration/g-509-suitability.test.ts',
  'tests/qa/integration/g-539-semantic-disclosure.test.ts',
  'tests/qa/integration/g-571-screen-support.ts',
  'tests/qa/integration/g-629-statement-context.test.ts',
  'tests/qa/integration/g-630-zone-routes.test.ts',
  'tests/qa/integration/g-650-resource-targets.test.ts',
  'tests/qa/integration/g-652-target-reviews.test.ts',
  'tests/qa/integration/g-693-wiki-journey.ts',
  'tests/qa/integration/g-704-contribution-loop.test.ts',
  'tests/qa/integration/g-824-library-traversal.test.ts',
  'tests/qa/integration/g-828-zone-browse.test.ts',
  'tests/qa/integration/g-829-public-reads.test.ts',
  'tests/qa/integration/g-833-realizations.test.ts',
  'tests/qa/integration/g-851-release-query.test.ts',
  'tests/qa/integration/g-892-collection-grain.test.ts',
  'tests/qa/integration/g-911-catalogue-names.test.ts',
  'tests/qa/integration/g-920-wiki-readers.test.ts',
  'tests/qa/integration/g-929-wiki-disclosure.test.ts',
  'tests/qa/integration/g-930-merge-authority.test.ts',
  'tests/qa/integration/g-935-rating-language.test.ts',
  'tests/qa/integration/g-965-saved-views.test.ts',
  'tests/qa/integration/g-991-owner-migrations.test.ts',
  'tests/qa/integration/hub-api.test.ts',
  'tests/qa/integration/library-copies-loans.test.ts',
  'tests/qa/integration/library-status.test.ts',
  'tests/qa/integration/library-write-scope.test.ts',
  'tests/qa/integration/main-selection-languages.test.ts',
  'tests/qa/integration/media-summary-disclosure-release.test.ts',
  'tests/qa/integration/member-reply-api.test.ts',
  'tests/qa/integration/membership-seek.test.ts',
  'tests/qa/integration/model-custody-backfill.test.ts',
  'tests/qa/integration/onboarding-concepts.test.ts',
  'tests/qa/integration/owner-operations.test.ts',
  'tests/qa/integration/owner-outbox-recovery.test.ts',
  'tests/qa/integration/owner-relay-gap.test.ts',
  'tests/qa/integration/post-author-notes-custody.test.ts',
  'tests/qa/integration/post-lifecycle.test.ts',
  'tests/qa/integration/post-search-disclosure.test.ts',
  'tests/qa/integration/private-original-source.test.ts',
  'tests/qa/integration/proposal-execution.test.ts',
  'tests/qa/integration/publication-selection-members.test.ts',
  'tests/qa/integration/query-templates.test.ts',
  'tests/qa/integration/ranking-progress.test.ts',
  'tests/qa/integration/rating-components.test.ts',
  'tests/qa/integration/rating-own-target.test.ts',
  'tests/qa/integration/rating-question-presentation-retire.test.ts',
  'tests/qa/integration/rating-question-presentation.test.ts',
  'tests/qa/integration/read-stability.test.ts',
  'tests/qa/integration/realm-create.test.ts',
  'tests/qa/integration/realm-directory.test.ts',
  'tests/qa/integration/realm-module.test.ts',
  'tests/qa/integration/realm-profile.test.ts',
  'tests/qa/integration/realm-submission-targets.test.ts',
  'tests/qa/integration/scoped-judgments.test.ts',
  'tests/qa/integration/search-card-fields.test.ts',
  'tests/qa/integration/search-card-rich.test.ts',
  'tests/qa/integration/search-chapter-book.test.ts',
  'tests/qa/integration/search-graph-sentinel.test.ts',
  'tests/qa/integration/search-source-title.test.ts',
  'tests/qa/integration/search-studio-chapter-content.test.ts',
  'tests/qa/integration/statement-disclosure.test.ts',
  'tests/qa/integration/structure-qualifier-root.test.ts',
  'tests/qa/integration/sys-receipt-relay-gap.test.ts',
  'tests/qa/integration/tag-proposal-api.test.ts',
  'tests/qa/integration/translated-work-links.test.ts',
  'tests/qa/integration/typeahead-cards.test.ts',
  'tests/qa/integration/validation-cross-profile.test.ts',
  'tests/qa/integration/work-continuities.test.ts',
  'tests/qa/integration/work-derivation.test.ts',
  'tests/qa/integration/work-serial-projection.test.ts',
  'tests/qa/integration/year-fact-read.test.ts',
  'tests/qa/integration/zone-document-home.test.ts',
  'tests/qa/integration/zone-presentation.test.ts',
  'tests/qa/integration/zone-published-metadata.test.ts',
  'tests/qa/integration/zone-realm-attachment.test.ts',
  'tests/qa/integration/zone-route-keyed.test.ts',
  'tests/qa/integration/zone-showcase-disclosure.test.ts',
  // Regression run 9 added the omitted direct callers and helper-dependent roots to this ceiling.
  'services/main/tests/content-projection.integration.test.ts',
  'services/main/tests/g-940-summary.integration.test.ts',
  'services/main/tests/management-read.integration.test.ts',
  'services/main/tests/outbox.integration.test.ts',
  'services/main/tests/profiles.integration.test.ts',
  'services/main/tests/realm-read.integration.test.ts',
  'services/main/tests/structure-group-root-owner.integration.test.ts',
  'services/main/tests/work-contents.integration.test.ts',
  'services/main/tests/work-metadata.integration.test.ts',
  'services/main/tests/work-read.integration.test.ts',
  'tests/qa/integration/chapter-seek.test.ts',
  'tests/qa/integration/discovery-read-isolation.test.ts',
  'tests/qa/integration/g-1003-address-navigation.test.ts',
  'tests/qa/integration/g-1011-optional-work-reads.test.ts',
  'tests/qa/integration/g-1034-realm-ranking.test.ts',
  'tests/qa/integration/g-506-target.test.ts',
  'tests/qa/integration/g-538-translation-basis.test.ts',
  'tests/qa/integration/g-571-profile-screen.test.ts',
  'tests/qa/integration/g-571-screen.test.ts',
  'tests/qa/integration/g-591-contribution-basis.test.ts',
  'tests/qa/integration/g-629-entity-page.test.ts',
  'tests/qa/integration/g-836-sao-public-api.test.ts',
  'tests/qa/integration/g-845-wiki-intake.test.ts',
  'tests/qa/integration/g-854-large-library.test.ts',
  'tests/qa/integration/g-856-discovery.test.ts',
  'tests/qa/integration/g-856-library.test.ts',
  'tests/qa/integration/g-856-readers.test.ts',
  'tests/qa/integration/g-937-creation.test.ts',
  'tests/qa/integration/g-937-migration.test.ts',
  'tests/qa/integration/g-937-scopes.test.ts',
  'tests/qa/integration/g-937-zone.test.ts',
  'tests/qa/integration/g-992-platform-name-repair.test.ts',
  'tests/qa/integration/identity-links.test.ts',
  'tests/qa/integration/podcast-playlist.test.ts',
  'tests/qa/integration/rating-release-target.test.ts',
  'tests/qa/integration/recipe-structure.test.ts',
  'tests/qa/integration/relation-star-cost.test.ts',
  'tests/qa/integration/search-grouped-native.test.ts',
  'tests/qa/integration/search-statement-query.test.ts',
  'tests/qa/integration/semantic-change-race.test.ts',
  'tests/qa/integration/semantic-generation.test.ts',
  'tests/qa/integration/source-authenticated-api.test.ts',
  'tests/qa/integration/source-author-credit.test.ts',
  'tests/qa/integration/validation-command.test.ts',
  'tests/qa/integration/work-address-api.test.ts',
  'tests/qa/integration/model-generation-refusal.test.ts',
]);

test('raw SPARQL integration files only shrink', () => {
  const added = [...rawSparqlIntegrationFiles()].filter(file => !ceiling.has(file)).sort();
  expect(added).toEqual([]);
}, SCAN_TIMEOUT_MS);

test('discovery replay inherits raw-fixture classification from its imported tests', () => {
  const wrapper = 'tests/qa/integration/discovery-read-isolation.test.ts';
  const sites = rawSparqlIntegrationScan().sites.get(wrapper) ?? [];

  expect(rawSparqlIntegrationFiles().has(wrapper)).toBe(true);
  for (const source of [
    'tests/qa/integration/export-api.test.ts',
    'tests/qa/integration/discovery-projection-fixture.ts',
    'tests/qa/integration/g-1001-work-cards.test.ts',
  ]) {
    expect(sites.some(site => site.startsWith(`${source}:`))).toBe(true);
  }
}, SCAN_TIMEOUT_MS);

const commandOnlyFiles = ['services/main/tests/governance-realm-authority.test.ts',
  'services/main/tests/governance-realm-restoration.test.ts',
  'services/main/tests/governance-realm-target.test.ts',
  'tests/qa/integration/structured-work-publication-native.test.ts',
  'tests/qa/integration/work-read-session-concurrent-writes.test.ts'];

test('migrated Realm, publication and concurrent-read fixtures cannot regain raw writes', () => {
  const files = rawSparqlIntegrationFiles();
  expect(commandOnlyFiles.filter(file => files.has(file))).toEqual([]);
}, SCAN_TIMEOUT_MS);

test('a planted raw write in any migrated fixture is detected and has no ceiling exemption', () => {
  const directory = mkdtempSync(resolve('.temp/raw-write-regression-'));
  try {
    for (const path of commandOnlyFiles) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), "export const seed = graph => graph.update('INSERT DATA {}');\n");
    }
    const scan = scanRawSparqlIntegrationFiles(directory);
    expect([...scan.files].filter(file => !ceiling.has(file)).sort()).toEqual([...commandOnlyFiles].sort());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
