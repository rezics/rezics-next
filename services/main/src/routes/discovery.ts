import { Elysia } from 'elysia';
import { discoveryPage, discoveryQuery } from '../modules/discovery/contract.ts';
import { discoveryError, discoveryManagementRoutes } from '../modules/discovery/management.ts';
import { readDiscovery } from '../modules/discovery/read.ts';
import { workRead } from '../modules/work/read-session.ts';
import { WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/works': { get: { bearer: false } },
  '/v1/discovery/generation-builds': { post: { bearer: true, idempotencyKey: true } },
  '/v1/discovery/generations/{generation}': { get: { bearer: true } },
  '/v1/discovery/generations/{generation}/advance': { post: { bearer: true } },
  '/v1/discovery/generations/{generation}/cancel': { post: { bearer: true } },
  '/v1/discovery/generation-activations': { post: { bearer: true, idempotencyKey: true } },
} as const;

/** Phrase-free discovery over a separately built, admitted population. */
export function discoveryRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/works', {
    query: discoveryQuery,
    detail: { security: [{}, { bearerAuth: [] }] },
    response: { 200: discoveryPage, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      // A public list never turns into a private inventory merely because a browser sent a token.
      if (!work.discovery) throw new WorkReadUnavailable('Discovery owner is unavailable');
      const mine = query.scope === 'mine';
      const readerRequest = mine ? request : new Request(request.url);
      return Response.json(await workRead(work, readerRequest,
        { ...query, actingSubject: mine ? query.actingSubject : undefined },
        session => readDiscovery(session, work.discovery!, query)),
        { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return discoveryError(error); }
  }).use(discoveryManagementRoutes(work));
}
