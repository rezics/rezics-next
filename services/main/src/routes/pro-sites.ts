import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { CommerceDenied, CommerceUnavailable } from '../modules/commerce/store.ts';
import { queryFixedSitePhrase, SiteBenefitRequired, SiteUnavailable,
  type FixedSiteStore } from '../modules/pro-site/store.ts';
import { withStableSearchSnapshot } from '../modules/work/search-readiness.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const language = t.Union([t.String({ minLength: 2, maxLength: 35,
  pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null()]);
const siteQueryBody = t.Object({ profile: t.Literal('fixed-site-phrase-v1'),
  site: t.String({ minLength: 3, maxLength: 253 }), phrase: t.String({ minLength: 2, maxLength: 80 }),
  language, author: t.Optional(agent), reader: t.Optional(agent) }, { additionalProperties: false });
const siteQueryResult = t.Object({ profile: t.Literal('fixed-site-phrase-v1'),
  site: t.Object({ id: t.String(), host: t.String(), revision: t.String(), realm: agent }),
  complete: t.Literal(true), total: t.Integer({ minimum: 0 }), results: t.Array(t.Object({
    matchUnit: t.String(), work: t.String(), mainVersion: t.String(), contribution: t.String(),
    revision: t.String(), selection: t.String(), language: t.String(), score: t.Number() })),
  indexGeneration: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

/** Fixed-Realm site reads: the host selects the Realm; no body field can widen it. */
export function fixedSiteRoutes(fuseki: FusekiClient, work: MainWorkDependencies & { sites?: FixedSiteStore }) {
  return new Elysia()
    .post('/v1/pro-sites/queries', {
      body: siteQueryBody,
      response: { 200: siteQueryResult, 400: problemResult(400), 401: problemResult(401),
        403: problemResult(403), 404: problemResult(404), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      try {
        if (!work.sites) return problem(503, 'site_unavailable', 'Site configuration is unavailable');
        const site = await work.sites.active(body.site);
        if (site.requiredBenefit) {
          const principal = await work.account.verify(request, ['work:read']);
          await work.sites.assertReader(site, principal, body.reader ?? '');
        }
        const result = await withStableSearchSnapshot(fuseki, () => queryFixedSitePhrase(work.environment, site,
          { phrase: body.phrase, language: body.language, author: body.author }));
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof SiteUnavailable) return problem(404, 'site_unavailable', 'Site is unavailable');
        if (error instanceof SiteBenefitRequired || error instanceof CommerceDenied) {
          return problem(403, 'site_benefit_required', 'Site content requires a current benefit');
        }
        if (error instanceof CommerceUnavailable) {
          return problem(503, 'site_unavailable', 'Site benefit state is unavailable');
        }
        return commandError(error);
      }
    });
}

export const openApiOperations = {
  '/v1/pro-sites/queries': { post: { exposure: 'platform:commerce', rateLimitFamily: 'read' } },
} as const;
