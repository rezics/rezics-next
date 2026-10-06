import { Elysia } from 'elysia';
import { discoveryPage, discoveryQuery, popularTermsPage, popularTermsQuery } from '../modules/discovery/contract.ts';
import { discoveryError, discoveryManagementRoutes } from '../modules/discovery/management.ts';
import { readDiscovery, readPopularTerms } from '../modules/discovery/read.ts';
import { workRead, publicWorkRead } from '../modules/work/read-session.ts';
import { WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadProblems } from './work-reads.ts';
import { workReadError } from './work-reads.ts';
import { conceptSearchPage, conceptSearchQuery, readConceptSearch } from '../modules/discovery/concepts.ts';
import { discoverySectionsPage, discoverySectionsQuery, readDiscoverySections } from '../modules/discovery/sections.ts';
import { RecommendationMissing, RecommendationRestart, RecommendationUnavailable } from '../modules/recommendation/derived-generation.ts';
import { problem } from './problems.ts';

export const openApiOperations = {
  '/v1/discovery/concepts': { get: { exposure: 'public', bearer: false } },
  '/v1/discovery/sections': { get: { exposure: 'public', bearer: false } },
  '/v1/works': { get: { exposure: 'public', bearer: false } },
  '/v1/discovery/popular-terms': { get: { exposure: 'public', bearer: false } },
  '/v1/discovery/generation-builds': { post: { exposure: 'platform:platform-admin', bearer: true, idempotencyKey: true } },
  '/v1/discovery/generations/{generation}': { get: { exposure: 'platform:platform-admin', bearer: true } },
  '/v1/discovery/generations/{generation}/advance': { post: { exposure: 'platform:platform-admin', bearer: true } },
  '/v1/discovery/generations/{generation}/cancel': { post: { exposure: 'platform:platform-admin', bearer: true } },
  '/v1/discovery/generation-activations': { post: { exposure: 'platform:platform-admin', bearer: true, idempotencyKey: true } },
} as const;

/** Phrase-free discovery over a separately built, admitted population. */
export function discoveryRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/discovery/concepts', { query: conceptSearchQuery,
    response: { 200: conceptSearchPage, ...workReadProblems } }, async ({ request, query }) => {
    try { return Response.json(await publicWorkRead(work, request, { limit: query.limit, cursor: query.cursor },
      session => readConceptSearch(session, query, request)), { headers: { 'cache-control': 'private, no-store' } }); }
    catch (error) { return workReadError(error); }
  }).get('/v1/discovery/sections', { query: discoverySectionsQuery,
    response: { 200: discoverySectionsPage, ...workReadProblems } }, async ({ request, query }) => {
    try { return Response.json(await publicWorkRead(work, request, { limit: query.limit, cursor: query.cursor },
      session => readDiscoverySections(session, query, request)), { headers: { 'cache-control': 'private, no-store' } }); }
    catch (error) {
      if (error instanceof RecommendationRestart) return problem(409, 'read_basis_changed', 'Restart the read from its first page');
      if (error instanceof RecommendationMissing || error instanceof RecommendationUnavailable) {
        return problem(503, 'discovery_ranking_unavailable', 'Public ranking is unavailable');
      }
      return workReadError(error);
    }
  }).get('/v1/works', {
    query: discoveryQuery,
    detail: { security: [{}, { bearerAuth: [] }] },
    response: { 200: discoveryPage, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      // A public list never turns into a private inventory merely because a browser sent a token.
      if (!work.discovery) throw new WorkReadUnavailable('Discovery owner is unavailable');
      const mine = query.scope === 'mine';
      const read = mine ? workRead : publicWorkRead;
      return Response.json(await read(work, request,
        { ...query, actingSubject: mine ? query.actingSubject : undefined, retainedBasis: true },
        session => readDiscovery(session, work.discovery!, query)),
        { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return discoveryError(error); }
  }).get('/v1/discovery/popular-terms', {
    query: popularTermsQuery, response: { 200: popularTermsPage, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      if (!work.discovery) throw new WorkReadUnavailable('Discovery owner is unavailable');
      return Response.json(await publicWorkRead(work, request, query,
        session => readPopularTerms(session, work.discovery!, query)),
      { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return discoveryError(error); }
  }).use(discoveryManagementRoutes(work));
}
