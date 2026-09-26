import { Elysia, NotFound, ParseError, ValidationError } from 'elysia';
import type { FusekiClient } from './infrastructure/fuseki.ts';
import { accessAuthorityRoutes } from './routes/access-authority.ts';
import { agentRoutes } from './routes/agents.ts';
import { accessMembershipRoutes } from './routes/access-memberships.ts';
import { accessPolicyRoutes } from './routes/access-policy.ts';
import { accessRoleRoutes } from './routes/access-roles.ts';
import { accessTopologyRoutes } from './routes/access-topology.ts';
import { actingContextRoutes } from './routes/acting-contexts.ts';
import { addressRoutes } from './routes/addresses.ts';
import { claimRoutes } from './routes/claims.ts';
import { classificationRoutes } from './routes/classification.ts';
import { commerceRoutes } from './routes/commerce.ts';
import { compositionRoutes } from './routes/compositions.ts';
import { progressRoutes } from './routes/progress.ts';
import { contentRoutes } from './routes/content.ts';
import { contextRoutes } from './routes/contexts.ts';
import { contributionRoutes } from './routes/contributions.ts';
import { erasureRoutes } from './routes/erasures.ts';
import { exportRoutes } from './routes/exports.ts';
import { healthRoutes } from './routes/health.ts';
import { hubRoutes } from './routes/hub.ts';
import { hubDependencyRoutes } from './routes/hub-deps.ts';
import { operationsRoutes } from './routes/operations.ts';
import { ownerRoutes } from './routes/owners.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { packageRoutes } from './routes/packages.ts';
import { packageLockRoutes } from './routes/package-locks.ts';
import { packageNixRoutes } from './routes/package-nix.ts';
import { packageModRoutes } from './routes/package-mods.ts';
import { pollRoutes } from './routes/polls.ts';
import { problem } from './routes/problems.ts';
import { protectionRoutes } from './routes/protection.ts';
import { publicationRoutes } from './routes/publication.ts';
import { reportRoutes } from './routes/reports.ts';
import { rightsRoutes } from './routes/rights.ts';
import { graphLayoutRoutes } from './routes/graph-layouts.ts';
import { recommendationRoutes } from './routes/recommendations.ts';
import { ratingRoutes } from './routes/ratings.ts';
import { realmReplyRoutes } from './routes/realm-replies.ts';
import { resourceRoutes } from './routes/resources.ts';
import { globalRatingRoutes } from './routes/rating-global.ts';
import { searchRoutes, type SearchRouteDependencies } from './routes/search.ts';
import { searchGenerationRoutes } from './routes/search-generations.ts';
import { relationRoutes } from './routes/relations.ts';
import { semanticRoutes } from './routes/semantic.ts';
import { sourceRoutes } from './routes/sources.ts';
import { sourceRunRoutes } from './routes/source-runs.ts';
import { sourceSupportRoutes } from './routes/source-supports.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { workRoutes } from './routes/works.ts';

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
    .use(hubDependencyRoutes(work))
    .use(agentRoutes(work))
    .use(erasureRoutes(work))
    .use(exportRoutes(work))
    .use(notificationRoutes(work))
    .use(reportRoutes(work))
    .use(rightsRoutes(work))
    .use(recommendationRoutes(work))
    .use(graphLayoutRoutes(work));
}

function extraRoutes1(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(workRoutes(fuseki, work))
    .use(ownerRoutes(work))
    .use(packageNixRoutes(work))
    .use(compositionRoutes(fuseki, work))
    .use(packageModRoutes(work))
    .use(realmReplyRoutes(work))
    .use(pollRoutes(work))
    .use(semanticRoutes(fuseki, work))
    .use(relationRoutes(fuseki, work));
}

function extraRoutes2(fuseki: FusekiClient, work: SearchRouteDependencies) {
  return new Elysia()
    .use(hubRoutes(work))
    .use(progressRoutes(fuseki, work));
}

/** Composition root: each domain plugin under `routes/` owns its registrations. */
export function createMainApp(fuseki: FusekiClient, work?: SearchRouteDependencies) {
  // Registered first so it also handles every plugin route mounted below.
  const app = new Elysia()
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
    // Generated by scripts/goal/normalize-app.ts: nested groups keep each .use() chain short
    // enough for TypeScript to infer MainApp. Add a domain plugin as one .use() line anywhere here.
    return app
      .use(identitySourceRoutes(fuseki, work))
      .use(accessSearchRoutes(fuseki, work))
      .use(contentCommunityRoutes(fuseki, work))
      .use(domainRoutes(fuseki, work))
      .use(extraRoutes1(fuseki, work))
      .use(extraRoutes2(fuseki, work));
  }
  return app;
}

/** Inferred product route contract consumed by first-party Eden clients. */
export type MainApp = Extract<ReturnType<typeof createMainApp>,
  { '~Routes': { v1: unknown } }>;
