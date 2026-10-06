// Route-owned declarations are bound once when Main is composed.
import { openApiOperations as owner0 } from '../../routes/access-authority.ts';
import { openApiOperations as owner1 } from '../../routes/access-memberships.ts';
import { openApiOperations as owner2 } from '../../routes/access-policy.ts';
import { openApiOperations as owner3 } from '../../routes/access-read.ts';
import { openApiOperations as owner4 } from '../../routes/access-roles.ts';
import { openApiOperations as owner5 } from '../../routes/access-topology.ts';
import { openApiOperations as owner6 } from '../../routes/acting-contexts.ts';
import { openApiOperations as owner7 } from '../../routes/addresses.ts';
import { openApiOperations as owner8 } from '../../routes/agents.ts';
import { openApiOperations as owner9 } from '../../routes/also-enjoyed.ts';
import { openApiOperations as owner10 } from '../../routes/authors.ts';
import { openApiOperations as owner11 } from '../../routes/catalog.ts';
import { openApiOperations as owner12 } from '../../routes/catalogue-candidates.ts';
import { openApiOperations as owner13 } from '../../routes/claims.ts';
import { openApiOperations as owner14 } from '../../routes/classification.ts';
import { openApiOperations as owner15 } from '../../routes/collection-grain.ts';
import { openApiOperations as owner16 } from '../../routes/collections.ts';
import { openApiOperations as owner17 } from '../../routes/commerce.ts';
import { openApiOperations as owner18 } from '../../routes/composition-reads.ts';
import { openApiOperations as owner19 } from '../../routes/compositions.ts';
import { openApiOperations as owner20 } from '../../routes/concepts.ts';
import { openApiOperations as owner21 } from '../../routes/connected-apps.ts';
import { openApiOperations as owner22 } from '../../routes/content-private-search.ts';
import { openApiOperations as owner23 } from '../../routes/content.ts';
import { openApiOperations as owner24 } from '../../routes/contexts.ts';
import { openApiOperations as owner25 } from '../../routes/continue.ts';
import { openApiOperations as owner26 } from '../../routes/contributions.ts';
import { openApiOperations as owner27 } from '../../routes/discovery.ts';
import { openApiOperations as owner28 } from '../../routes/editorial-proposals.ts';
import { openApiOperations as owner29 } from '../../routes/entity-pages.ts';
import { openApiOperations as owner30 } from '../../routes/erasures.ts';
import { openApiOperations as owner31 } from '../../routes/events.ts';
import { openApiOperations as owner32 } from '../../routes/exports.ts';
import { openApiOperations as owner33 } from '../../routes/facets.ts';
import { openApiOperations as owner34 } from '../../routes/feed.ts';
import { openApiOperations as owner35 } from '../../routes/follows.ts';
import { openApiOperations as owner36 } from '../../routes/graph-layouts.ts';
import { openApiOperations as owner37 } from '../../routes/graph-queries.ts';
import { openApiOperations as owner38 } from '../../routes/health.ts';
import { openApiOperations as owner39 } from '../../routes/hub-deps.ts';
import { openApiOperations as owner40 } from '../../routes/hub.ts';
import { openApiOperations as owner41 } from '../../routes/judgments.ts';
import { openApiOperations as owner42 } from '../../routes/lexicon.ts';
import { openApiOperations as owner43 } from '../../routes/library-export.ts';
import { openApiOperations as owner44 } from '../../routes/library-imports.ts';
import { openApiOperations as owner45 } from '../../routes/library.ts';
import { openApiOperations as owner46 } from '../../routes/managed-realms.ts';
import { openApiOperations as owner47 } from '../../routes/management-reads.ts';
import { openApiOperations as owner48 } from '../../routes/mcp.ts';
import { openApiOperations as owner49 } from '../../routes/media.ts';
import { openApiOperations as owner50 } from '../../routes/member-replies.ts';
import { openApiOperations as owner51 } from '../../routes/memberships.ts';
import { openApiOperations as owner52 } from '../../routes/notifications.ts';
import { openApiOperations as owner53 } from '../../routes/onboarding-interests.ts';
import { openApiOperations as owner54 } from '../../routes/onboarding.ts';
import { openApiOperations as owner55 } from '../../routes/operations.ts';
import { openApiOperations as owner56 } from '../../routes/owners.ts';
import { openApiOperations as owner57 } from '../../routes/package-install-requests.ts';
import { openApiOperations as owner58 } from '../../routes/package-locks.ts';
import { openApiOperations as owner59 } from '../../routes/package-mods.ts';
import { openApiOperations as owner60 } from '../../routes/package-nix.ts';
import { openApiOperations as owner61 } from '../../routes/packages.ts';
import { openApiOperations as owner62 } from '../../routes/polls.ts';
import { openApiOperations as owner63 } from '../../routes/post-identification.ts';
import { openApiOperations as owner64 } from '../../routes/posts.ts';
import { openApiOperations as owner65 } from '../../routes/preferences.ts';
import { openApiOperations as owner66 } from '../../routes/pro-sites.ts';
import { openApiOperations as owner67 } from '../../routes/profiles.ts';
import { openApiOperations as owner68 } from '../../routes/progress-summaries.ts';
import { openApiOperations as owner69 } from '../../routes/progress.ts';
import { openApiOperations as owner70 } from '../../routes/projections.ts';
import { openApiOperations as owner71 } from '../../routes/proposals.ts';
import { openApiOperations as owner72 } from '../../routes/protection.ts';
import { openApiOperations as owner73 } from '../../routes/public-reports.ts';
import { openApiOperations as owner74 } from '../../routes/publication.ts';
import { openApiOperations as owner75 } from '../../routes/query.ts';
import { openApiOperations as owner76 } from '../../routes/quota.ts';
import { openApiOperations as owner77 } from '../../routes/rankings.ts';
import { openApiOperations as owner78 } from '../../routes/rating-contexts.ts';
import { openApiOperations as owner79 } from '../../routes/rating-global.ts';
import { openApiOperations as owner80 } from '../../routes/rating-populations.ts';
import { openApiOperations as owner81 } from '../../routes/rating-question-presentations.ts';
import { openApiOperations as owner82 } from '../../routes/rating-rollups.ts';
import { openApiOperations as owner83 } from '../../routes/ratings.ts';
import { openApiOperations as owner84 } from '../../routes/reading-positions.ts';
import { openApiOperations as owner85 } from '../../routes/reading-settings.ts';
import { openApiOperations as owner86 } from '../../routes/realizations.ts';
import { openApiOperations as owner87 } from '../../routes/realm-admin.ts';
import { openApiOperations as owner88 } from '../../routes/realm-directory.ts';
import { openApiOperations as owner89 } from '../../routes/realm-profile.ts';
import { openApiOperations as owner90 } from '../../routes/realm-reads.ts';
import { openApiOperations as owner91 } from '../../routes/realm-replies.ts';
import { openApiOperations as owner92 } from '../../routes/realm-reply-threads.ts';
import { openApiOperations as owner93 } from '../../routes/realm-submissions.ts';
import { openApiOperations as owner94 } from '../../routes/recipes.ts';
import { openApiOperations as owner95 } from '../../routes/recommendations.ts';
import { openApiOperations as owner96 } from '../../routes/relations.ts';
import { openApiOperations as owner97 } from '../../routes/releases.ts';
import { openApiOperations as owner98 } from '../../routes/reports.ts';
import { openApiOperations as owner99 } from '../../routes/resource-relations.ts';
import { openApiOperations as owner100 } from '../../routes/resources.ts';
import { openApiOperations as owner101 } from '../../routes/reviews.ts';
import { openApiOperations as owner102 } from '../../routes/rights.ts';
import { openApiOperations as owner103 } from '../../routes/safety-cases.ts';
import { openApiOperations as owner104 } from '../../routes/saved-filters.ts';
import { openApiOperations as owner105 } from '../../routes/search-generations.ts';
import { openApiOperations as owner106 } from '../../routes/search.ts';
import { openApiOperations as owner107 } from '../../routes/semantic.ts';
import { openApiOperations as owner108 } from '../../routes/sessions.ts';
import { openApiOperations as owner109 } from '../../routes/source-runs.ts';
import { openApiOperations as owner110 } from '../../routes/source-supports.ts';
import { openApiOperations as owner111 } from '../../routes/sources.ts';
import { openApiOperations as owner112 } from '../../routes/spaces.ts';
import { openApiOperations as owner113 } from '../../routes/studio.ts';
import { openApiOperations as owner114 } from '../../routes/suitability.ts';
import { openApiOperations as owner115 } from '../../routes/themes.ts';
import { openApiOperations as owner116 } from '../../routes/types.ts';
import { openApiOperations as owner117 } from '../../routes/web-publications.ts';
import { openApiOperations as owner118 } from '../../routes/wiki-evidence.ts';
import { openApiOperations as owner119 } from '../../routes/wiki-history.ts';
import { openApiOperations as owner120 } from '../../routes/wiki.ts';
import { openApiOperations as owner121 } from '../../routes/work-activity.ts';
import { openApiOperations as owner122 } from '../../routes/work-contents.ts';
import { openApiOperations as owner123 } from '../../routes/work-maintainers.ts';
import { openApiOperations as owner124 } from '../../routes/work-metadata.ts';
import { openApiOperations as owner125 } from '../../routes/work-reads.ts';
import { openApiOperations as owner126 } from '../../routes/work-stats.ts';
import { openApiOperations as owner127 } from '../../routes/works-import.ts';
import { openApiOperations as owner128 } from '../../routes/works.ts';
import { openApiOperations as owner129 } from '../../routes/zone-modules.ts';
import { openApiOperations as owner130 } from '../../routes/zones.ts';
import { openApiOperations as owner131 } from '../../routes/platform-access.ts';
import type { ExposureDeclarations } from './exposure.ts';

export const exposureDeclarations: readonly ExposureDeclarations[] = [
  owner0,
  owner1,
  owner2,
  owner3,
  owner4,
  owner5,
  owner6,
  owner7,
  owner8,
  owner9,
  owner10,
  owner11,
  owner12,
  owner13,
  owner14,
  owner15,
  owner16,
  owner17,
  owner18,
  owner19,
  owner20,
  owner21,
  owner22,
  owner23,
  owner24,
  owner25,
  owner26,
  owner27,
  owner28,
  owner29,
  owner30,
  owner31,
  owner32,
  owner33,
  owner34,
  owner35,
  owner36,
  owner37,
  owner38,
  owner39,
  owner40,
  owner41,
  owner42,
  owner43,
  owner44,
  owner45,
  owner46,
  owner47,
  owner48,
  owner49,
  owner50,
  owner51,
  owner52,
  owner53,
  owner54,
  owner55,
  owner56,
  owner57,
  owner58,
  owner59,
  owner60,
  owner61,
  owner62,
  owner63,
  owner64,
  owner65,
  owner66,
  owner67,
  owner68,
  owner69,
  owner70,
  owner71,
  owner72,
  owner73,
  owner74,
  owner75,
  owner76,
  owner77,
  owner78,
  owner79,
  owner80,
  owner81,
  owner82,
  owner83,
  owner84,
  owner85,
  owner86,
  owner87,
  owner88,
  owner89,
  owner90,
  owner91,
  owner92,
  owner93,
  owner94,
  owner95,
  owner96,
  owner97,
  owner98,
  owner99,
  owner100,
  owner101,
  owner102,
  owner103,
  owner104,
  owner105,
  owner106,
  owner107,
  owner108,
  owner109,
  owner110,
  owner111,
  owner112,
  owner113,
  owner114,
  owner115,
  owner116,
  owner117,
  owner118,
  owner119,
  owner120,
  owner121,
  owner122,
  owner123,
  owner124,
  owner125,
  owner126,
  owner127,
  owner128,
  owner129,
  owner130,
  owner131,
];
