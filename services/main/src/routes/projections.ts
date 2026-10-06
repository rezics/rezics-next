import { Elysia } from 'elysia';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { PendingContextCommand } from '../modules/context/command.ts';
import { ControlUnavailable } from '../modules/access/topology-control.ts';
import { getOrCreateProjection } from '../modules/projection/command.ts';
import { listProjections, lookupProjection } from '../modules/projection/read.ts';
import { MAX_PAGE, ProjectionRefused, ProjectionUnavailable, projectionPage, projectionQuery, projectionRequest,
  projectionWriteResponse } from '../modules/projection/schema.ts';
import { workRead, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { readingBoundary } from '../modules/reading-position/boundary.ts';

const headers = { 'cache-control': 'private, no-store' };
export const openApiOperations = {
  '/v1/projections': { post: { exposure: 'public', bearer: true, idempotencyKey: true }, get: { exposure: 'public', bearer: false } },
} as const;

function projectionError(error: unknown): Response {
  if (error instanceof ProjectionRefused) return problem(error.status, error.code, error.message);
  if (error instanceof ProjectionUnavailable || error instanceof ControlUnavailable) {
    return problem(503, 'projection_unavailable', 'Projection owner is unavailable');
  }
  if (error instanceof PendingContextCommand) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: error.family,
      result: null, retry: { allowed: true, afterMs: 1000 } }, { status: 202, headers: { ...headers, 'retry-after': '1' } });
  }
  return workReadError(error);
}

export function projectionRoutes(deps: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/projections', {
      body: projectionRequest,
      response: { 200: projectionWriteResponse, 201: projectionWriteResponse, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422), 429: problemResult(429) },
    }, async ({ request, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const result = await getOrCreateProjection(deps, request, { ...body, idempotencyKey: key });
        return Response.json(result, { status: result.created && !result.replayed ? 201 : 200, headers });
      } catch (error) { return projectionError(error); }
    })
    .get('/v1/projections', {
      query: projectionQuery,
      response: { 200: projectionPage, ...workReadProblems },
    }, async ({ request, query }) => {
      try {
        const store = deps.projections;
        if (!store) throw new WorkReadUnavailable('Projection owner is unavailable');
        // Scalar query decoding keeps only the first value; reject ambiguous selection instead.
        const search = new URL(request.url).searchParams;
        if (['subject', 'frame'].some(key => search.getAll(key).length > 1)) {
          return problem(400, 'invalid_projection', 'A listing selects at most one subject and one frame');
        }
        if (query.frames !== undefined && (!query.subject || query.frame !== undefined || query.cursor !== undefined)) {
          return problem(400, 'invalid_projection', 'An exact frame-set lookup requires a subject and has no frame filter or continuation');
        }
        if (!query.subject && !query.frame) return problem(400, 'invalid_projection', 'A subject or frame is required');
        const result = await workRead(deps, request, query, async session => {
          const boundary = readingBoundary(session);
          const page = query.frames !== undefined
            ? await lookupProjection(session, store, { subject: query.subject!, frames: query.frames }, boundary)
              .then(found => ({ items: found ? [found] : [], nextCursor: null }))
            : await listProjections(session, store, { subject: query.subject, frame: query.frame, cursor: query.cursor ?? null,
              limit: query.limit ?? MAX_PAGE }, boundary);
          await boundary.fence();
          return { ...page, sourcePosition: session.position };
        });
        return Response.json(result, { headers });
      } catch (error) { return projectionError(error); }
    });
}
