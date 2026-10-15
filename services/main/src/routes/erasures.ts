import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { logWorkerFault } from '@rezics/observability/log';
import { ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { ContentErasureGraphRequired, ContentErasureInvalid, ContentErasureStale,
  MAX_CONTENT_ERASURE_TARGETS } from '../modules/erasure/content.ts';
import { ErasureConflict, ErasureInvalid, ErasureNotFound, ErasureStale, ErasureUnavailable,
  ErasurePreflightUnsupported, MAX_ERASURE_TARGETS, MAX_ERASURE_DISPOSITIONS,
  type ErasureReport } from '../modules/erasure/journal.ts';
import { ErasureDenied, ErasureNotApplied, readRequestedErasure,
  requestContentErasure } from '../modules/erasure/request.ts';
import { publicRetentionReason } from '../modules/erasure/retention-reasons.ts';
import { GraphErasureConflict, GraphErasureUnavailable } from '../modules/erasure/graph.ts';
import { MediaErasureUnsupported } from '../modules/media/erasure.ts';
import { MediaFenced, MediaStale, MediaUnavailable } from '../modules/media/store.ts';
import { DESTRUCTION_STATUSES, DISPOSITION_DESTRUCTION, DISPOSITION_SUPPRESSION,
  ERASURE_DEFERRED_REASON,
  ERASURE_KINDS, ERASURE_STAGES, ERASURE_TARGET_COMPLETION_STATES,
  RETENTION_CUSTODY, RETENTION_OWNERS, RETENTION_STORES,
  SUPPRESSION_STATUSES } from '../modules/erasure/schema.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupUuid } from './shared.ts';

export const openApiOperations = {
  '/v1/erasures': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/erasures/{erasureId}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
} as const;

const literals = (values: readonly string[]) => t.Union(values.map(value => t.Literal(value)));
const instant = t.String({ format: 'date-time' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });

const contentErasureBody = t.Object({ profile: t.Literal('content-revision-erasure-v1'),
  actingSubject: groupAgent, resourceId: groupAgent,
  revisionIds: t.Array(groupUuid, { minItems: 1, maxItems: MAX_CONTENT_ERASURE_TARGETS }) },
{ additionalProperties: false });

const erasureResult = t.Object({ profile: t.Literal('erasure-v1'), erasureId: groupUuid,
  erasureEpoch: t.String({ pattern: '^[1-9][0-9]*$' }), kind: literals(ERASURE_KINDS),
  stage: literals(ERASURE_STAGES), suppression: literals(SUPPRESSION_STATUSES),
  destruction: literals(DESTRUCTION_STATUSES), blockedReason: t.Nullable(t.String()),
  requestedAt: instant, suppressedAt: t.Nullable(instant), verifiedAt: t.Nullable(instant),
  targets: t.Array(t.Object({ owner: t.String(), kind: t.String(), ref: t.String(),
    completionState: literals(ERASURE_TARGET_COMPLETION_STATES), completedAt: t.Nullable(instant) }),
  { maxItems: MAX_ERASURE_TARGETS }),
  dispositions: t.Array(t.Object({ domain: t.String(), owner: literals(RETENTION_OWNERS),
    store: literals(RETENTION_STORES), custody: literals(RETENTION_CUSTODY),
    suppression: literals(DISPOSITION_SUPPRESSION), destruction: literals(DISPOSITION_DESTRUCTION),
    retainedUntil: t.Nullable(instant), reason: t.Nullable(t.String()),
    evidenceDigest: t.Nullable(digest) }), { maxItems: MAX_ERASURE_DISPOSITIONS }),
  replayed: t.Boolean() });

function result(report: ErasureReport, replayed: boolean): Response {
  return Response.json({ profile: 'erasure-v1', erasureId: report.erasureId,
    erasureEpoch: report.erasureEpoch, kind: report.kind, stage: report.stage,
    suppression: report.suppression, destruction: report.destruction,
    blockedReason: report.stage === 'blocked' || report.blockedReason !== null ? ERASURE_DEFERRED_REASON : null,
    requestedAt: report.requestedAt,
    suppressedAt: report.suppressedAt, verifiedAt: report.verifiedAt,
    targets: report.targets.map(({ owner, kind, ref, completionState, completedAt }) =>
      ({ owner, kind, ref, completionState, completedAt })),
    // Hold bases and per-target diagnostic evidence remain in the owner journal.
    dispositions: report.stage === 'blocked' ? [] : report.dispositions.map(disposition => ({ ...disposition,
      reason: publicRetentionReason(disposition.reason) })),
    replayed }, { headers: { 'cache-control': 'no-store' } });
}

function erasureError(error: unknown): Response {
  if (error instanceof ErasurePreflightUnsupported || error instanceof MediaErasureUnsupported) {
    logWorkerFault('main.erasure.inventory_unsupported', error, { messages: false });
    return problem(409, 'erasure_inventory_unsupported',
      'Erasure targets cannot be completely inventoried within supported limits');
  }
  if (error instanceof ContentErasureInvalid || error instanceof ErasureInvalid) {
    return problem(400, 'invalid_erasure', 'Erasure targets are unavailable or invalid');
  }
  if (error instanceof ErasureDenied) return problem(403, 'erasure_denied', 'Erasure is not admitted');
  if (error instanceof ErasureNotFound) return problem(404, 'erasure_unavailable', 'Erasure is unavailable');
  if (error instanceof ErasureConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  }
  if (error instanceof ErasureStale || error instanceof ContentErasureStale || error instanceof MediaStale) {
    return problem(409, 'erasure_target_stale', 'A target is already erased or changed');
  }
  if (error instanceof MediaFenced) return problem(409, 'erasure_deferred', ERASURE_DEFERRED_REASON);
  if (error instanceof ContentErasureGraphRequired) {
    return problem(409, 'graph_suppression_unavailable', 'Published Content needs graph suppression');
  }
  if (error instanceof GraphErasureConflict) {
    return problem(409, 'graph_erasure_conflict', 'Exact graph erasure conflicts with existing state');
  }
  if (error instanceof GraphErasureUnavailable) {
    return problem(503, 'graph_suppression_unavailable', 'Graph suppression is unavailable');
  }
  if (error instanceof ErasureNotApplied) return problem(409, 'erasure_not_applied', 'Erasure was cancelled');
  if (error instanceof ErasureUnavailable || error instanceof ObjectUnavailable || error instanceof MediaUnavailable) {
    logWorkerFault('main.erasure.incomplete', error, { messages: false });
    return problem(503, 'erasure_incomplete', 'Erasure completion could not be verified');
  }
  return commandError(error);
}

export function erasureRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/erasures', {
      body: contentErasureBody,
      response: transportResponses(openApiOperations["/v1/erasures"].post, { 200: erasureResult, ...writeProblems }, 'POST'),
    }, async ({ request, body }) => {
      try {
        if (!work.erasures) return problem(503, 'erasure_unavailable', 'Erasure owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
          return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        }
        const { report, replayed } = await requestContentErasure(work.erasures, work.environment, work.account,
          work.access, request, { actingSubject: body.actingSubject, resourceId: body.resourceId,
            revisionIds: body.revisionIds, idempotencyKey: key });
        return result(report, replayed);
      } catch (error) { return erasureError(error); }
    })
    .get('/v1/erasures/:erasureId', {
      params: t.Object({ erasureId: groupUuid }),
      response: transportResponses(openApiOperations["/v1/erasures/{erasureId}"].get, { 200: erasureResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }) => {
      try {
        if (!work.erasures) return problem(503, 'erasure_unavailable', 'Erasure owner is unavailable');
        return result(await readRequestedErasure(work.erasures, work.account, work.access,
          request, params.erasureId), false);
      } catch (error) { return erasureError(error); }
    });
}
