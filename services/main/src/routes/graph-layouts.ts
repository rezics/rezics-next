import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { GraphLayoutBody } from '../modules/graph-layout/schema.ts';
import {
  GraphLayoutConflict, GraphLayoutDenied, GraphLayoutMissing, type GraphLayouts, GraphLayoutStale,
  GraphLayoutUnavailable,
} from '../modules/graph-layout/store.ts';
import { digest } from '../modules/recommendation/derived-generation.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/** Route dependencies beyond MainWorkDependencies; the composition root passes the same object. */
export interface GraphLayoutDependencies { graphLayouts?: GraphLayouts }

const iri = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

const layoutRevision = t.Object({
  profile: t.Literal('graph-layout-v1'), layout: iri, owner: iri,
  view: t.Object({ profile: t.String(), anchor: iri, context: t.Nullable(iri) }),
  revision: uuid, predecessor: t.Nullable(uuid), byteDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  body: GraphLayoutBody, replayed: t.Boolean(),
});

const noStore = { headers: { 'cache-control': 'no-store' } };

function layoutError(error: unknown): Response {
  if (error instanceof GraphLayoutDenied) return problem(403, 'graph_layout_denied', 'Graph layout authority is missing');
  if (error instanceof GraphLayoutConflict) return problem(409, 'idempotency_conflict', 'Layout intent conflicts with an earlier request');
  if (error instanceof GraphLayoutStale) return problem(409, 'stale_head', 'Layout head changed');
  if (error instanceof GraphLayoutMissing) return problem(404, 'graph_layout_unavailable', 'Graph layout is unavailable');
  if (error instanceof GraphLayoutUnavailable) return problem(503, 'graph_layout_owner_unavailable', 'Graph layout owner is unavailable');
  return commandError(error);
}

/** Saved graph layouts: presentation state stored as Content revisions, never relation truth. */
export function graphLayoutRoutes(work: MainWorkDependencies & GraphLayoutDependencies) {
  const unavailable = () => problem(503, 'graph_layout_owner_unavailable', 'Graph layout owner is unavailable');
  return new Elysia()
    .post('/v1/graph-layouts', {
      body: t.Object({ profile: t.Literal('graph-layout-change-v1'), actingSubject: iri,
        layout: t.Nullable(iri), expectedHead: t.Nullable(uuid), body: GraphLayoutBody },
      { additionalProperties: false }),
      response: { 200: layoutRevision, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        if (!work.graphLayouts) return unavailable();
        const key = request.headers.get('idempotency-key');
        if (!key || key.length > 128 || key.includes('\0')) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        if ((body.layout === null) !== (body.expectedHead === null)) {
          return problem(400, 'invalid_request', 'A revision names both its layout and expected head');
        }
        const saved = await work.graphLayouts.save({ principal, actingSubject: body.actingSubject },
          body.layout, body.expectedHead, body.body, { idempotencyKey: key, requestDigest: digest(body) });
        return Response.json({ profile: 'graph-layout-v1', ...saved, replayed: saved.replayed ?? false }, noStore);
      } catch (error) { return layoutError(error); }
    })
    .get('/v1/graph-layouts/:layoutId', {
      params: t.Object({ layoutId: uuid }),
      query: t.Object({ actingSubject: iri, revision: t.Optional(uuid) }, { additionalProperties: false }),
      response: { 200: layoutRevision, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.graphLayouts) return unavailable();
        const layout = await work.graphLayouts.read({ principal, actingSubject: query.actingSubject },
          `https://rezics.com/id/${params.layoutId}`, query.revision);
        return Response.json({ profile: 'graph-layout-v1', ...layout, replayed: false }, noStore);
      } catch (error) { return layoutError(error); }
    });
}

export const openApiOperations = {
  '/v1/graph-layouts/{layoutId}': { get: { exposure: 'platform:worldbuilding', rateLimitFamily: 'read' } },
  '/v1/graph-layouts': { post: { exposure: 'platform:worldbuilding', rateLimitFamily: 'write' } },
} as const;
