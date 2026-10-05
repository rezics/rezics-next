import { safetyCaseRoutes } from './routes/safety-cases.ts';
import { membershipsRoutes } from './routes/memberships.ts';
import { Elysia, NotFound, ParseError, ValidationError } from 'elysia';
import { httpTelemetry } from '@rezics/observability/elysia';
import { mcpRoutes } from './routes/mcp.ts';
import { entityPageRoutes, setMountedReads } from './routes/entity-pages.ts';
import { readingPositionsRoutes } from './routes/reading-positions.ts';
import type { FusekiClient } from './infrastructure/fuseki.ts';
import { accessAuthorityRoutes } from './routes/access-authority.ts';
import { agentRoutes } from './routes/agents.ts';
import { authorRoutes } from './routes/authors.ts';
import { onboardingRoutes } from './routes/onboarding.ts';
import { accessMembershipRoutes } from './routes/access-memberships.ts';
import { managedRealmRoutes } from './routes/managed-realms.ts';
import { accessPolicyRoutes } from './routes/access-policy.ts';
import { accessReadRoutes } from './routes/access-read.ts';
import { accessRoleRoutes } from './routes/access-roles.ts';
import { accessTopologyRoutes } from './routes/access-topology.ts';
import { actingContextRoutes } from './routes/acting-contexts.ts';
import { addressRoutes } from './routes/addresses.ts';
import { claimRoutes } from './routes/claims.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { classificationRoutes } from './routes/classification.ts';
import { connectedAppRoutes } from './routes/connected-apps.ts';
import { commerceRoutes } from './routes/commerce.ts';
import { compositionRoutes } from './routes/compositions.ts';
import { compositionReadRoutes } from './routes/composition-reads.ts';
import { collectionRoutes } from './routes/collections.ts';
import { collectionGrainRoutes } from './routes/collection-grain.ts';
import { zoneRoutes } from './routes/zones.ts';
import { progressRoutes } from './routes/progress.ts';
import { sessionsRoutes } from './routes/sessions.ts';
import { progressSummariesRoutes } from './routes/progress-summaries.ts';
import { contentRoutes } from './routes/content.ts';
import { contextRoutes } from './routes/contexts.ts';
import { contributionRoutes } from './routes/contributions.ts';
import { erasureRoutes } from './routes/erasures.ts';
import { publicReportRoutes } from './routes/public-reports.ts';
import { eventRoutes } from './routes/events.ts';
import { exportRoutes } from './routes/exports.ts';
import { healthRoutes } from './routes/health.ts';
import { hubRoutes } from './routes/hub.ts';
import { hubDependencyRoutes } from './routes/hub-deps.ts';
import { operationsRoutes } from './routes/operations.ts';
import { ownerRoutes } from './routes/owners.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { packageRoutes } from './routes/packages.ts';
import { packageLockRoutes } from './routes/package-locks.ts';
import { packageInstallRequestRoutes } from './routes/package-install-requests.ts';
import { packageNixRoutes } from './routes/package-nix.ts';
import { packageModRoutes } from './routes/package-mods.ts';
import { pollRoutes } from './routes/polls.ts';
import { proposalRoutes } from './routes/proposals.ts';
import { judgmentRoutes } from './routes/judgments.ts';
import { problem } from './routes/problems.ts';
import { protectionRoutes } from './routes/protection.ts';
import { publicationRoutes } from './routes/publication.ts';
import { reportRoutes } from './routes/reports.ts';
import { editorialProposalRoutes } from './routes/editorial-proposals.ts';
import { rightsRoutes } from './routes/rights.ts';
import { graphLayoutRoutes } from './routes/graph-layouts.ts';
import { graphQueryRoutes } from './routes/graph-queries.ts';
import { recommendationRoutes } from './routes/recommendations.ts';
import { recipeRoutes } from './routes/recipes.ts';
import { ratingRoutes } from './routes/ratings.ts';
import { realmReplyRoutes } from './routes/realm-replies.ts';
import { memberReplyRoutes } from './routes/member-replies.ts';
import { realmReplyThreadRoutes } from './routes/realm-reply-threads.ts';
import { workMaintainerRoutes } from './routes/work-maintainers.ts';
import { resourceRoutes } from './routes/resources.ts';
import { globalRatingRoutes } from './routes/rating-global.ts';
import { searchRoutes, type SearchRouteDependencies } from './routes/search.ts';
import { searchGenerationRoutes } from './routes/search-generations.ts';
import { relationRoutes } from './routes/relations.ts';
import { resourceRelationRoutes } from './routes/resource-relations.ts';
import { semanticRoutes } from './routes/semantic.ts';
import { lexiconRoutes } from './routes/lexicon.ts';
import { sourceRoutes } from './routes/sources.ts';
import { sourceRunRoutes } from './routes/source-runs.ts';
import { sourceSupportRoutes } from './routes/source-supports.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { workRoutes } from './routes/works.ts';
import { catalogueImportRoutes } from './routes/works-import.ts';
import { catalogueCandidateRoutes } from './routes/catalogue-candidates.ts';
import { themeRoutes } from './routes/themes.ts';
import { contentPrivateSearchRoutes } from './routes/content-private-search.ts';
import { workReadRoutes } from './routes/work-reads.ts';
import { alsoEnjoyedRoutes } from './routes/also-enjoyed.ts';
import { workStatsRoutes } from './routes/work-stats.ts';
import { realmReadRoutes } from './routes/realm-reads.ts';
import { zoneModuleRoutes } from './routes/zone-modules.ts';
import { rankingRoutes } from './routes/rankings.ts';
import { realmDirectoryRoutes } from './routes/realm-directory.ts';
import { realmSubmissionRoutes } from './routes/realm-submissions.ts';
import { conceptRoutes } from './routes/concepts.ts';
import { realmAdminRoutes } from './routes/realm-admin.ts';
import { workContentsRoutes } from './routes/work-contents.ts';
import { readingSettingsRoutes } from './routes/reading-settings.ts';
import { preferencesRoutes } from './routes/preferences.ts';
import { suitabilityRoutes } from './routes/suitability.ts';
import { projectionRoutes } from './routes/projections.ts';
import { workActivityRoutes } from './routes/work-activity.ts';
import { profileRoutes } from './routes/profiles.ts';
import { studioRoutes } from './routes/studio.ts';
import { postIdentificationRoutes } from './routes/post-identification.ts';
import { postRoutes } from './routes/posts.ts';
import { ratingRollupRoutes } from './routes/rating-rollups.ts';
import { libraryRoutes } from './routes/library.ts';
import { libraryImportsRoutes } from './routes/library-imports.ts';
import { libraryExportRoutes } from './routes/library-export.ts';
import { realmProfileRoutes } from './routes/realm-profile.ts';
import { workMetadataRoutes } from './routes/work-metadata.ts';
import { releaseRoutes } from './routes/releases.ts';
import { realizationRoutes } from './routes/realizations.ts';
import { webPublicationRoutes } from './routes/web-publications.ts';
import { discoveryRoutes } from './routes/discovery.ts';
import { ratingPopulationRoutes } from './routes/rating-populations.ts';
import { followsRoutes } from './routes/follows.ts';
import { feedRoutes } from './routes/feed.ts';
import { reviewRoutes } from './routes/reviews.ts';
import { continueRoutes } from './routes/continue.ts';
import { onboardingInterestsRoutes } from './routes/onboarding-interests.ts';
import { ratingContextReadRoutes } from './routes/rating-contexts.ts';
import { ratingQuestionPresentationRoutes } from './routes/rating-question-presentations.ts';
import { managementReadRoutes } from './routes/management-reads.ts';
import { facetRoutes } from './routes/facets.ts';
import { typeRoutes } from './routes/types.ts';
import { typeAdministrationRoutes } from './routes/types.ts';
import { queryRoutes } from './routes/query.ts';
import { savedFilterRoutes } from './routes/saved-filters.ts';
import { wikiRoutes, wikiSchemaError } from './routes/wiki.ts';
import { wikiHistoryRoutes } from './routes/wiki-history.ts';
import { wikiEvidenceRoutes } from './routes/wiki-evidence.ts';
import { rateLimitHook } from './modules/rate-limit/hook.ts';
import { composeDisclosure } from './modules/disclosure/assembly.ts';

export type { MainWorkDependencies } from './routes/dependencies.ts';

function identitySourceRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(operationsRoutes(work))
    .use(actingContextRoutes(work))
    .use(sourceRoutes(work))
    .use(sourceRunRoutes(work))
    .use(packageRoutes(work))
    .use(packageLockRoutes(work))
    .use(sourceSupportRoutes(fuseki, work))
    .use(accessAuthorityRoutes(work))
    .use(accessMembershipRoutes(work));
}

function accessSearchRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(accessRoleRoutes(work))
    .use(accessPolicyRoutes(work))
    .use(accessTopologyRoutes(work))
    .use(searchRoutes(fuseki, work))
    .use(searchGenerationRoutes(fuseki, work))
    .use(contentRoutes(fuseki, work))
    .use(ratingRoutes(fuseki, work))
    .use(globalRatingRoutes(work))
    .use(classificationRoutes(fuseki, work));
}

function contentCommunityRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(contextRoutes(fuseki, work))
    .use(spaceRoutes(fuseki, work))
    .use(publicationRoutes(fuseki, work))
    .use(contributionRoutes(fuseki, work))
    .use(addressRoutes(work))
    .use(commerceRoutes(fuseki, work))
    .use(resourceRoutes(fuseki, work))
    .use(protectionRoutes(work))
    .use(claimRoutes(work));
}

function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(new Elysia()
    .use(libraryImportsRoutes(work))
    .use(libraryExportRoutes(work))
    .use(collectionGrainRoutes(work))
    .use(accessReadRoutes(work))
    .use(catalogueCandidateRoutes(work))
    .use(wikiRoutes(fuseki, work))
    .use(wikiHistoryRoutes(work))
    .use(wikiEvidenceRoutes(work))
    .use(editorialProposalRoutes(work))
    )
    .use(new Elysia()
    .use(suitabilityRoutes(work))
    .use(sessionsRoutes(work))
    .use(publicReportRoutes(work))
    .use(safetyCaseRoutes(work))
    .use(progressSummariesRoutes(work))
    .use(readingPositionsRoutes(work))
    .use(queryRoutes(fuseki, work))
    .use(savedFilterRoutes(work))
    .use(reviewRoutes(work))
    )
    .use(managedRealmRoutes(work))
    .use(resourceRelationRoutes(fuseki, work))
    .use(postIdentificationRoutes(work))
    .use(membershipsRoutes(work))
    .use(new Elysia().use(postRoutes(work)).use(studioRoutes(work)));
}

function extraRoutes1(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(realmAdminRoutes(work))
    .use(entityPageRoutes(work))
    .use(memberReplyRoutes(work))
    .use(workMaintainerRoutes(work))
    .use(lexiconRoutes(fuseki, work))
    .use(compositionReadRoutes(work))
    .use(workReadRoutes(work))
    .use(alsoEnjoyedRoutes(work))
    .use(releaseRoutes(work));
}

function extraRoutes2(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(realizationRoutes(work))
    .use(webPublicationRoutes(work))
    .use(realmReadRoutes(work))
    .use(preferencesRoutes(work))
    .use(realmReplyThreadRoutes(work))
    .use(zoneModuleRoutes(work))
    .use(rankingRoutes(work))
    .use(realmDirectoryRoutes(work))
    .use(continueRoutes(work));
}

function extraRoutes3(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(onboardingInterestsRoutes(work))
    .use(workContentsRoutes(work))
    .use(workActivityRoutes(work))
    .use(followsRoutes(work))
    .use(feedRoutes(work))
    .use(profileRoutes(work))
    .use(readingSettingsRoutes(work))
    .use(onboardingRoutes(work))
    .use(libraryRoutes(work));
}

function extraRoutes4(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(realmProfileRoutes(work))
    .use(workMetadataRoutes(work))
    .use(discoveryRoutes(work))
    .use(ratingContextReadRoutes(work))
    .use(ratingQuestionPresentationRoutes(work))
    .use(managementReadRoutes(work))
    .use(conceptRoutes(work))
    .use(realmSubmissionRoutes(work))
    .use(collectionRoutes(fuseki, work))
    .use(zoneRoutes(fuseki, work));
}

function extraRoutes5(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(hubDependencyRoutes(work))
    .use(packageInstallRequestRoutes(work))
    .use(agentRoutes(work))
    .use(catalogRoutes(work))
    .use(erasureRoutes(work))
    .use(eventRoutes(work))
    .use(exportRoutes(work))
    .use(notificationRoutes(work))
    .use(reportRoutes(work));
}

function extraRoutes6(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(rightsRoutes(work))
    .use(recommendationRoutes(work))
    .use(contentPrivateSearchRoutes(work))
    .use(graphLayoutRoutes(work))
    .use(graphQueryRoutes(work))
    .use(workRoutes(fuseki, work))
    .use(catalogueImportRoutes(work))
    .use(judgmentRoutes(work))
    .use(proposalRoutes(work))
    .use(recipeRoutes(fuseki, work));
}

function extraRoutes7(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(themeRoutes(work))
    .use(packageNixRoutes(work))
    .use(compositionRoutes(fuseki, work))
    .use(connectedAppRoutes(work))
    .use(ownerRoutes(work))
    .use(packageModRoutes(work))
    .use(realmReplyRoutes(work))
    .use(pollRoutes(work))
    .use(semanticRoutes(fuseki, work))
    .use(ratingRollupRoutes(work));
}

function extraRoutes8(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(relationRoutes(fuseki, work))
    .use(hubRoutes(work))
    .use(authorRoutes(work))
    .use(progressRoutes(fuseki, work))
    .use(workStatsRoutes(work))
    .use(facetRoutes())
    .use(typeAdministrationRoutes(work))
    .use(typeRoutes())
    .use(ratingPopulationRoutes(work))
    .use(projectionRoutes(work));
}

/** Composition root: each domain plugin under `routes/` owns its registrations. */
export function createMainApp(fuseki: FusekiClient, work?: SearchRouteDependencies) {
  work?.memberships?.configureFollowGraph?.(fuseki);
  work?.privateMemberships?.configureFollowGraph?.(fuseki);
  work?.realmAdmin?.configureFollowGraph?.(fuseki);
  if (work) composeDisclosure(work);
  // Registered first so it also handles every plugin route mounted below.
  const app = new Elysia()
    .use(httpTelemetry())
    .error(({ error, request }) => wikiSchemaError(error, request))
    .request(async ({ request }) => {
      if (new URL(request.url).pathname.startsWith('/health/')) return;
      try { await work?.types?.refresh(); }
      catch {
        if (request.method !== 'GET' && request.method !== 'HEAD')
          return problem(503, 'types_unavailable', 'Type registry is unavailable');
      }
    })
    .error(({ error }) => {
      if (error instanceof ValidationError || error instanceof ParseError) {
        return problem(400, 'invalid_request', 'Request does not match the Work contract');
      }
      // Unknown paths and unsupported methods on known paths.
      if (error instanceof NotFound) return problem(404, 'not_found', 'No such operation');
      return problem(500, 'internal_error', 'Request could not be processed');
    })
    .use(healthRoutes(fuseki, work));
  if (work) {
    setMountedReads(() => new Set(app.routes.filter(route => route.method === 'GET').map(route => route.path)));
    // Generated by scripts/goal/normalize-app.ts: nested groups keep each .use() chain short
    // enough for TypeScript to infer MainApp. Add a domain plugin as one .use() line anywhere here.
    return app
      .use(rateLimitHook(work.account, work.rateLimit))
      .use(identitySourceRoutes(fuseki, work))
      .use(accessSearchRoutes(fuseki, work))
      .use(contentCommunityRoutes(fuseki, work))
      .use(domainRoutes(fuseki, work))
      .use(mcpRoutes(work, request => app.handle(request)))
      .use(extraRoutes1(fuseki, work))
      .use(extraRoutes2(fuseki, work))
      .use(extraRoutes3(fuseki, work))
      .use(extraRoutes4(fuseki, work))
      .use(extraRoutes5(fuseki, work))
      .use(extraRoutes6(fuseki, work))
      .use(extraRoutes7(fuseki, work))
      .use(extraRoutes8(fuseki, work));
  }
  return app;
}

/** Inferred product route contract consumed by first-party Eden clients. */
export type MainApp = Extract<ReturnType<typeof createMainApp>,
  { '~Routes': { v1: unknown } }>;
