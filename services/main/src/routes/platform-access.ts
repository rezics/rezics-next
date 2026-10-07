import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { anonymousPlatformAccess } from '../modules/access/exposure.ts';
import { PlatformAccessUnavailable } from '../modules/access/platform-permissions.ts';
import { platformExposureProblem } from '../modules/access/exposure-routes.ts';
import type { MainWorkDependencies } from './dependencies.ts';

export const openApiOperations = {
  '/v1/me/platform-access': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;

export function platformAccessRoutes(work: MainWorkDependencies) {
  return new Elysia().get(
    '/v1/me/platform-access',
    {
      response: {
        200: t.Object({
          groups: t.Array(t.String(), { maxItems: 128 }),
          operations: t.Array(t.String(), { maxItems: 64 }),
          generation: t.String(),
        }),
        401: problemResult(401),
        503: problemResult(503),
      },
    },
    async ({ request }) => {
      try {
        const principal = request.headers.has('authorization')
          ? await work.account.verify(request, [])
          : undefined;
        if (principal && !work.platformAccess)
          throw new PlatformAccessUnavailable('Platform access is unavailable');
        const summary =
          principal && work.platformAccess
            ? await work.platformAccess.summary(principal)
            : anonymousPlatformAccess();
        return Response.json(summary, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) {
        return platformExposureProblem(error);
      }
    },
  );
}
