import { Elysia, NotFound, ParseError, ValidationError } from 'elysia';
import type { FusekiClient } from './infrastructure/fuseki.ts';
import { accessAuthorityRoutes } from './routes/access-authority.ts';
import { accessMembershipRoutes } from './routes/access-memberships.ts';
import { accessRoleRoutes } from './routes/access-roles.ts';
import { actingContextRoutes } from './routes/acting-contexts.ts';
import { addressRoutes } from './routes/addresses.ts';
import { classificationRoutes } from './routes/classification.ts';
import { contentRoutes } from './routes/content.ts';
import { contributionRoutes } from './routes/contributions.ts';
import type { MainWorkDependencies } from './routes/dependencies.ts';
import { healthRoutes } from './routes/health.ts';
import { operationsRoutes } from './routes/operations.ts';
import { packageRoutes } from './routes/packages.ts';
import { problem } from './routes/problems.ts';
import { publicationRoutes } from './routes/publication.ts';
import { ratingRoutes } from './routes/ratings.ts';
import { searchRoutes } from './routes/search.ts';
import { sourceRoutes } from './routes/sources.ts';
import { sourceSupportRoutes } from './routes/source-supports.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { workRoutes } from './routes/works.ts';

export type { MainWorkDependencies } from './routes/dependencies.ts';

/** Composition root: each domain plugin under `routes/` owns its registrations. */
export function createMainApp(fuseki: FusekiClient, work?: MainWorkDependencies) {
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
    return app
      .use(operationsRoutes(work))
      .use(actingContextRoutes(work))
      .use(sourceRoutes(work))
      .use(packageRoutes(work))
      .use(sourceSupportRoutes(fuseki, work))
      .use(accessAuthorityRoutes(work))
      .use(accessMembershipRoutes(work))
      .use(accessRoleRoutes(work))
      .use(searchRoutes(fuseki, work))
      .use(contentRoutes(fuseki, work))
      .use(ratingRoutes(fuseki, work))
      .use(classificationRoutes(fuseki, work))
      .use(spaceRoutes(fuseki, work))
      .use(publicationRoutes(fuseki, work))
      .use(contributionRoutes(fuseki, work))
      .use(addressRoutes(work))
      .use(workRoutes(fuseki, work));
  }
  return app;
}

/** Inferred product route contract consumed by first-party Eden clients. */
export type MainApp = Extract<ReturnType<typeof createMainApp>,
  { '~Routes': { v1: unknown } }>;
