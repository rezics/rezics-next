import { Elysia, t } from 'elysia';
import { websocket } from 'elysia/websocket';
import { problemResult } from '../api-contract.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { ContentPrivateConnection, contentPrivateProblem }
  from '../modules/search-disclosure/content-socket.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { requireSelectedPlatformCapability } from '../modules/access/exposure.ts';
import { resolvedSemanticCapabilities } from '../modules/semantic/admitted.ts';

export const openApiOperations = {
  '/v1/private-content-queries': { post: { exposure: 'public', bearer: true } , ws: { exposure: 'public' } },
} as const;

export function contentPrivateSearchRoutes(work: MainWorkDependencies) {
  const principals = new WeakMap<Request, VerifiedPrincipal>();
  const connections = new Map<string, ContentPrivateConnection>();
  const owners = work.contentPrivateSearch;
  return new Elysia().use(websocket({ sendPings: false }))
    .post('/v1/private-content-queries', {
      body: t.Object({ profile: t.Literal('private-content-phrase-v1'),
        resource: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        variant: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ transport: t.Literal('websocket'), path: t.Literal('/v1/private-content-queries') }),
        400: problemResult(400), 401: problemResult(401), 403: problemResult(403), 503: problemResult(503) },
    }, async ({ request, body }) => {
      if (!owners) return problem(503, 'private_search_unavailable',
        'Private Content phrase delivery is unavailable');
      try {
        const principal = await work.account.verify(request, ['work:read']);
        for (const exposure of await resolvedSemanticCapabilities(work.environment, [body.resource]))
          await requireSelectedPlatformCapability(work.platformAccess, principal,
            { exposure, operationId: 'postV1Private-content-queries' });
      }
      catch (error) {
        const failure = contentPrivateProblem(error);
        return problem(failure.status, failure.code, failure.title,
          failure.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined);
      }
      return Response.json({ transport: 'websocket', path: '/v1/private-content-queries' },
        { headers: { 'cache-control': 'no-store' } });
    })
    .ws('/v1/private-content-queries', {
      detail: { hide: true }, maxPayloadLength: 4_096, idleTimeout: 30,
      async beforeHandle({ request }) {
        if (!owners) return problem(503, 'private_search_unavailable',
          'Private Content phrase delivery is unavailable');
        try { principals.set(request, await work.account.verify(request, ['work:read'])); }
        catch (error) {
          const failure = contentPrivateProblem(error);
          return problem(failure.status, failure.code, failure.title,
            failure.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined);
        }
      },
      open(ws) {
        const principal = principals.get(ws.request);
        if (!owners || !principal) return ws.close(4503, 'private_search_unavailable');
        connections.set(ws.id, new ContentPrivateConnection(work.environment, owners,
          principal, { send: frame => ws.send(frame), close: (code, reason) => ws.close(code, reason),
            terminate: () => ws.terminate() }, work.platformAccess));
      },
      async message(ws, body) { await connections.get(ws.id)?.message(body); },
      async close(ws) {
        const connection = connections.get(ws.id);
        connections.delete(ws.id);
        await connection?.closed();
      },
    });
}
