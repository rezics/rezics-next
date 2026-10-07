import { Elysia, t } from 'elysia';
import { AdmissionDenied, AdmissionUnavailable } from '../modules/access/admission.ts';
import { EventObservationUnavailable, InvalidEventObservation, StaleEventObservation }
  from '../modules/event/observation.ts';
import { setAdmittedEventObservation } from '../modules/event/observation-admitted.ts';
import { EventQueryDenied, EventQueryRestart, EventQueryUnavailable,
  type EventQueryInput } from '../modules/event/queries.ts';
import { InvalidEventObservationInput, UnsupportedEventTime,
  type EventObservationIntent } from '../modules/event/time.ts';
import { IdempotencyConflict } from '../modules/work/activate.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { problemResult } from '../api-contract.ts';

export const openApiOperations = {
  '/v1/events/observations': { post: { exposure: 'platform:events', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/events/queries': { post: { exposure: 'platform:events', rateLimitFamily: 'read', bearer: true } },
} as const;

export interface EventRouteDependencies { eventQueries?: { query(input: EventQueryInput): Promise<unknown> } }

const iri = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const timeValue = t.Object({ kind: t.Literal('temporal'), lexical: t.String({ minLength: 1, maxLength: 64 }),
  precision: t.Union([t.Literal('year'), t.Literal('month'), t.Literal('day'), t.Literal('minute'), t.Literal('second')]),
  calendar: t.Literal('gregorian'), timeZone: t.Optional(t.String({ minLength: 1, maxLength: 64 })) }, { additionalProperties: false });
const point = t.Union([
  t.Object({ state: t.Literal('known'), value: timeValue }, { additionalProperties: false }),
  t.Object({ state: t.Union([t.Literal('unknown'), t.Literal('open')]), lexical: t.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
]);
const sourcePositionView = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const contentRevision = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const writeView = t.Object({ profile: t.Literal('event-time-observation-v1'), event: iri, eventTime: t.String(),
  timeStatus: t.Union([t.Literal('actual'), t.Literal('planned')]), observationRevision: iri,
  predecessor: t.Nullable(iri), recordedAt: t.String(), sourcePosition: sourcePositionView, replayed: t.Boolean() });
const queryView = t.Object({ profile: t.Literal('event-query-v1'), state: t.Literal('ready'), interpretation: t.Union([t.Literal('civil-date'), t.Literal('instant')]),
  match: t.Union([t.Literal('possible'), t.Literal('definite')]), timeStatus: t.Optional(t.Union([t.Literal('actual'), t.Literal('planned')])),
  sourcePosition: sourcePositionView, generation: uuid, generationRevision: t.String(),
  items: t.Array(t.Object({ event: iri, eventTime: t.String(), timeRevision: iri,
    timeStatus: t.Union([t.Literal('actual'), t.Literal('planned')]), temporalKind: t.Union([t.Literal('instant'), t.Literal('interval')]),
    certainty: t.Union([t.Literal('possible'), t.Literal('definite')]), start: t.Any(), end: t.Optional(t.Any()),
    topicStatements: t.Array(iri, { maxItems: 8 }) }), { maxItems: 50 }),
  histogram: t.Array(t.Object({ timeStatus: t.Union([t.Literal('actual'), t.Literal('planned')]),
    bucketStart: t.String(), definite: t.Integer({ minimum: 0 }), possible: t.Integer({ minimum: 0 }) }), { maxItems: 732 }),
  continuation: t.Nullable(t.String({ maxLength: 1024 })) });
const queryProgressView = t.Object({ profile: t.Literal('event-query-v1'),
  state: t.Union([t.Literal('unavailable'), t.Literal('partial')]),
  progress: t.Object({ phase: t.Union([t.Literal('backfill'), t.Literal('targets'), t.Literal('buckets')]),
    processed: t.String({ pattern: '^[0-9]+$' }), windowProcessed: t.String({ pattern: '^[0-9]+$' }), failed: t.Boolean() }),
  items: t.Array(t.Any(), { maxItems: 0 }), histogram: t.Array(t.Any(), { maxItems: 0 }), continuation: t.Null() });

function eventError(error: unknown) {
  if (error instanceof InvalidEventObservation || error instanceof InvalidEventObservationInput) {
    return problem(400, 'invalid_event_observation', 'Event time observation is invalid');
  }
  if (error instanceof UnsupportedEventTime) {
    return problem(422, 'unsupported_event_time', 'The requested event time comparison is unsupported');
  }
  if (error instanceof StaleEventObservation || error instanceof EventQueryRestart) {
    return problem(409, error instanceof StaleEventObservation ? 'stale_head' : 'event_query_restart',
      error instanceof StaleEventObservation ? 'Expected event time head is stale' : 'Event query changed; restart without its cursor');
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', 'Event observation authority is not admitted');
  if (error instanceof IdempotencyConflict) return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with another event intent');
  if (error instanceof EventQueryDenied) return problem(400, 'invalid_event_query', 'Event query is invalid');
  if (error instanceof EventObservationUnavailable || error instanceof EventQueryUnavailable || error instanceof AdmissionUnavailable) {
    return problem(503, 'event_owner_unavailable', 'Event data or owner state is unavailable');
  }
  return commandError(error);
}

export function eventRoutes(work: MainWorkDependencies & EventRouteDependencies) {
  return new Elysia()
    .post('/v1/events/observations', {
      body: t.Object({ profile: t.Literal('event-time-observation-v1'), event: iri,
        timeStatus: t.Union([t.Literal('actual'), t.Literal('planned')]),
        temporalKind: t.Union([t.Literal('instant'), t.Literal('interval')]), start: point,
        end: t.Optional(point), expectedRevisionHead: t.Nullable(iri), actingSubject: iri,
        timeEvidence: t.Optional(contentRevision) }, { additionalProperties: false }),
      response: { 200: writeView, 201: writeView, 202: t.Any(),
        ...Object.fromEntries([400, 401, 403, 409, 422, 500, 503].map(status => [status, problemResult(status)])) },
    }, async ({ request, body }: { request: Request;
      body: EventObservationIntent & { profile: 'event-time-observation-v1' } }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A bounded Idempotency-Key is required');
      }
      try {
        const receipt = await setAdmittedEventObservation(work.environment, work.account, work.access, work.content,
          request, { event: body.event, timeStatus: body.timeStatus, temporalKind: body.temporalKind,
            start: body.start, ...(body.end ? { end: body.end } : {}),
            expectedRevisionHead: body.expectedRevisionHead, actingSubject: body.actingSubject,
            ...(body.timeEvidence ? { timeEvidence: body.timeEvidence } : {}), idempotencyKey });
        return Response.json({ profile: 'event-time-observation-v1', event: receipt.event!, eventTime: receipt.eventTime!,
          timeStatus: receipt.timeStatus!, observationRevision: receipt.revision!, predecessor: receipt.predecessor ?? null,
          recordedAt: receipt.recordedAt!, sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return eventError(error); }
    })
    .post('/v1/events/queries', {
      body: t.Object({ profile: t.Literal('event-query-v1'), interpretation: t.Union([t.Literal('civil-date'), t.Literal('instant')]),
        match: t.Union([t.Literal('possible'), t.Literal('definite')]),
        timeStatus: t.Optional(t.Union([t.Literal('actual'), t.Literal('planned')])),
        grain: t.Union([t.Literal('year'), t.Literal('month'), t.Literal('day')]),
        start: t.String({ minLength: 1, maxLength: 64 }), end: t.String({ minLength: 1, maxLength: 64 }),
        pageSize: t.Integer({ minimum: 1, maximum: 50 }), topics: t.Optional(t.Array(iri, { maxItems: 8 })),
        acceptance: t.Optional(t.Union([t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm'), realm: iri }, { additionalProperties: false })])),
        continuation: t.Optional(t.String({ minLength: 1, maxLength: 1024 })) }, { additionalProperties: false }),
      response: { 200: t.Union([queryView, queryProgressView]), 422: problemResult(422),
        ...Object.fromEntries([400, 401, 403, 409, 500, 503].map(status => [status, problemResult(status)])) },
    }, async ({ request, body }: { request: Request;
      body: EventQueryInput & { profile: 'event-query-v1' } }) => {
      try {
        await work.account.verify(request, ['event:read']);
        if (!work.eventQueries) return problem(503, 'event_owner_unavailable', 'Event query owner is unavailable');
        const result = await work.eventQueries.query(body as EventQueryInput);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return eventError(error); }
    });
}
