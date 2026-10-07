import { Elysia, t } from 'elysia';
import { BackpressureSaturated, BackpressureUnavailable,
  type AdmissionLease, type LeaseOutcome } from '../operations/admission-budget.ts';
import { contentProjectionPositions, OperationsBackpressure,
  relayHandoffPositions } from '../operations/backpressure.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { readProblems } from '../api-responses.ts';
import { problem } from './problems.ts';

/** Every Content command appends one Content outbox event for the projection worker. */
const WORKER_INTENTS = new Set(['/v1/content-drafts', '/v1/content-comments',
  '/v1/content-publications', '/v1/content-search-eligibility']);
/** Graph commands that append a Main outbox batch for the relay handoff. */
const BROKER_INTENTS = new Set(['/v1/work-imports', '/v1/work-imports/bulk', '/v1/works', '/v1/fixed-releases', '/v1/content-edits']);
/** Commands that upload immutable Work components when an object store is configured. */
const OBJECT_INTENTS = new Set(['/v1/work-imports', '/v1/work-imports/bulk', '/v1/works']);

const decimal = t.String({ pattern: '^(0|[1-9][0-9]*)$' });
const laneState = t.Union([t.Literal('open'), t.Literal('saturated'),
  t.Literal('unavailable'), t.Literal('unobserved')]);
const durableLane = (lane: 'worker' | 'broker') => t.Object({ lane: t.Literal(lane),
  state: laneState, maxBacklog: t.Integer({ minimum: 1 }), dataEpoch: t.Nullable(t.String()),
  head: t.Nullable(decimal), delivered: t.Nullable(decimal), backlog: t.Nullable(decimal) },
{ additionalProperties: false });
const count = t.Integer({ minimum: 0 });
const backpressureResult = t.Object({ profile: t.String({ pattern: '^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]*$' }),
  complete: t.Boolean(),
  lanes: t.Tuple([durableLane('worker'), durableLane('broker'), t.Object({
    lane: t.Literal('object'), state: laneState, maxInFlight: t.Integer({ minimum: 1 }),
    maxBytes: t.Integer({ minimum: 1 }),
    counters: t.Nullable(t.Object({ inFlight: count, bytesInFlight: count, admitted: count,
      rejected: count, completed: count, refused: count, failed: count },
    { additionalProperties: false })) }, { additionalProperties: false })]),
}, { additionalProperties: false });

function refusal(error: unknown): Response | undefined {
  if (error instanceof BackpressureSaturated) {
    return problem(503, 'backpressure_saturated', `The ${error.lane} budget is saturated; retry later`,
      { 'retry-after': String(error.retryAfterSeconds) });
  }
  if (error instanceof BackpressureUnavailable) {
    return problem(503, 'backpressure_unavailable', `The ${error.lane} budget cannot be observed`);
  }
  return undefined;
}

interface SettledContext {
  responseValue?: unknown;
  error?: unknown;
  set: { status?: unknown };
}

/** Handlers return Response objects; thrown errors carry no response value. */
function outcome(context: SettledContext): LeaseOutcome {
  const status = context.responseValue instanceof Response ? context.responseValue.status
    : typeof context.set.status === 'number' ? context.set.status
      : context.error === undefined ? 200 : 500;
  return status >= 500 ? 'failed' : status >= 400 ? 'refused' : 'completed';
}

function declaredBytes(request: Request): number {
  const length = Number(request.headers.get('content-length') ?? '0');
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

/**
 * OPS06 admission at the Main boundary. Registered before the command plugins
 * so its global hooks see their routes. Each gated POST adds at most two owner
 * position reads (worker) or one in-process admission (object) before the
 * command's own fixed call plan; a refusal happens before any owner effect.
 */
export function operationsRoutes(work: MainWorkDependencies,
  backpressure = new OperationsBackpressure({
    ...(work.contentProjection ? { worker: contentProjectionPositions(work.contentProjection.content,
      work.contentProjection.cursor, work.contentProjection.consumer) } : {}),
    ...(work.relayPosition && work.environment ? { broker: relayHandoffPositions(
      work.environment.fuseki, work.environment.lineage.dataEpoch,
      () => work.relayPosition!.read()) } : {}),
    object: Boolean(work.environment?.workObjects || work.environment?.objectDirectory),
  }, work.backpressureProfile)) {
  const leases = new WeakMap<Request, AdmissionLease>();
  return new Elysia({ name: 'operations-backpressure' })
    .beforeHandle('global', async ({ request }) => {
      if (request.method !== 'POST') return;
      const path = new URL(request.url).pathname;
      try {
        if (WORKER_INTENTS.has(path)) await backpressure.admitDurable('worker');
        if (BROKER_INTENTS.has(path)) await backpressure.admitDurable('broker');
        if (OBJECT_INTENTS.has(path) && backpressure.objects) {
          leases.set(request, backpressure.objects.admit(declaredBytes(request)));
        }
      } catch (error) {
        const response = refusal(error);
        if (response) return response;
        throw error;
      }
    })
    .afterResponse('global', (context) => {
      const lease = leases.get(context.request);
      if (!lease) return;
      leases.delete(context.request);
      lease.settle(outcome(context as unknown as SettledContext));
    })
    .get('/v1/operations/backpressure', {
      response: { 200: backpressureResult, ...readProblems },
    }, async () => Response.json(await backpressure.read(),
      { headers: { 'cache-control': 'no-store' } }));
}

export const openApiOperations = {
  '/v1/operations/backpressure': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;
