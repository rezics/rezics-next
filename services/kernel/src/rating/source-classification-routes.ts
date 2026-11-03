import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { withConnection } from '../database/pool.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { accessCheck, actorOf, type Access, type Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { routeOf } from '../route/route.ts';
import { createSourceClassificationProducer, SOURCE_CLASSIFICATION_WRITE_ACTION } from './source-classification.ts';
import { classificationDigest, validateClassificationAssociation, validateClassificationClear,
  validateClassificationObservation, type ClassificationAssociation, type SourceClassificationRead } from './source-classification-contract.ts';
import { SourceClassificationBatchInputSchema, SourceClassificationBatchSchema, SourceClassificationPutInputSchema,
  SourceClassificationClearInputSchema, SourceClassificationPutSchema, SourceClassificationClearResultSchema } from './source-classification-http.ts';

export type SourceClassificationRouteDependencies = {
  pool: Pool; access: () => Access; routeKey: Uint8Array; clock?: KernelClock;
};
const closed = { additionalProperties: false } as const;
const params = t.Object({ id: t.String({ format: 'uuid' }) }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const failures = {
  400: problemSchema('invalid_request'), 401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'), 404: problemSchema('not_found'), 409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict', 'too_many_events'),
  503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
};
const sessionHeaders = { [SESSION_HEADER]: t.Optional(t.String()) };
function detail(operationId: string, write = false) {
  return { operationId, 'x-action': write ? SOURCE_CLASSIFICATION_WRITE_ACTION : 'subject:read',
    'x-exposure': write ? 'gate:personal_library' : 'public',
    security: write ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}) };
}
function validate(subjectId: string, associations: readonly ClassificationAssociation[], body: unknown) {
  try {
    if (Buffer.byteLength(JSON.stringify(body)) > 65536) throw new TypeError('Body exceeds byte bound');
    if (routeOf(subjectId) === null) throw new ProblemError('not_found');
    for (const a of associations) {
      validateClassificationAssociation(a);
      if (a.subjectId !== subjectId) throw new TypeError('Association belongs to another Subject');
    }
  } catch (error) {
    if (error instanceof TypeError) throw new ProblemError('invalid_request');
    throw error;
  }
}
async function translate<T>(run: () => Promise<T>) {
  try { return await run(); } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof TypeError || error instanceof RangeError) throw new ProblemError('invalid_request');
    throw error;
  }
}
function currentProjection(items: readonly SourceClassificationRead[]) {
  // Age describes the instant of selection. A later second is not a changed observation or authority.
  return items.map(item => {
    if (item.state !== 'available') return item;
    const { ageSeconds: _age, ...value } = item.value;
    return { state: item.state, value };
  });
}
/** Only supplied exact Semantic identities are accepted. No classification inventory or retained-history route. */
export function sourceClassificationRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: SourceClassificationRouteDependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  async function actions(actor: Actor, deadline: number): Promise<('put' | 'clear')[]> {
    if (actor.kind !== 'account') return [];
    const check = await accessCheck(dependencies.access(), actor, SOURCE_CLASSIFICATION_WRITE_ACTION,
      { route: 0, id: GLOBAL_CONTEXT }, { pool: dependencies.pool, deadline });
    const allowed = await withConnection(dependencies.pool, client => check(deadlineClient(client, deadline)));
    return allowed ? ['put', 'clear'] : [];
  }
  return app.post(customMethod('/v1/subjects/:id/source-classifications', 'read'), {
    params, body: SourceClassificationBatchInputSchema,
    response: { 200: SourceClassificationBatchSchema, ...failures }, detail: detail('rating.source_classifications_read'),
  }, async ({ actor, params, body, admission, job, request, set }) => {
    validate(params.id, body.associations, body);
    set.headers['cache-control'] = 'no-store';
    if (!body.associations.length) return { items: [], actions: [] };
    return admission.run('normal', job, async () => {
      const producer = createSourceClassificationProducer(config());
      const input = { actor, subjectId: params.id, associations: body.associations, limit: 32, deadline: job.deadline };
      const selected = { items: [...await producer.readBatch(input)], actions: await actions(actor, job.deadline) };
      // Freeze response bytes before final current checks; retained payload never escapes on a changed identity/head.
      const bytes = JSON.stringify(selected);
      const current = await actorOf(dependencies.access(), request, { pool: dependencies.pool, deadline: job.deadline });
      if (classificationDigest(actor) !== classificationDigest(current)) throw new ProblemError('not_found');
      const final = { items: [...await producer.readBatch({ ...input, actor: current })], actions: await actions(current, job.deadline) };
      if (classificationDigest([currentProjection(final.items), final.actions]) !==
          classificationDigest([currentProjection(selected.items), selected.actions])) return { items: body.associations.map(() => ({ state: 'unavailable' as const, reason: 'changed' as const })), actions: [] };
      return JSON.parse(bytes) as typeof selected;
    });
  }).post(customMethod('/v1/subjects/:id/source-classifications', 'put'), {
    params, headers, body: SourceClassificationPutInputSchema,
    response: { 200: withHeaders(SourceClassificationPutSchema, sessionHeaders), ...failures },
    detail: detail('rating.source_classification_put', true),
  }, async ({ actor, params, body, headers, admission, job, session, set }) => {
    validate(params.id, [body.association], body);
    await translate(async () => validateClassificationObservation(body.value));
    const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
    const outcome = await admission.run('normal', job, () => translate(() => createSourceClassificationProducer(config()).put({
      ...body, actor, idempotencyKey: key, deadline: job.deadline,
    })));
    session.record({ partition: outcome.partition, epoch: outcome.epoch, position: outcome.position });
    set.headers['cache-control'] = 'no-store';
    return outcome.value;
  }).post(customMethod('/v1/subjects/:id/source-classifications', 'clear'), {
    params, headers, body: SourceClassificationClearInputSchema,
    response: { 200: withHeaders(SourceClassificationClearResultSchema, sessionHeaders), ...failures },
    detail: detail('rating.source_classification_clear', true),
  }, async ({ actor, params, body, headers, admission, job, session, set }) => {
    validate(params.id, [body.association], body);
    await translate(async () => validateClassificationClear(body.value));
    const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
    const outcome = await admission.run('normal', job, () => translate(() => createSourceClassificationProducer(config()).clear({
      ...body, actor, idempotencyKey: key, deadline: job.deadline,
    })));
    session.record({ partition: outcome.partition, epoch: outcome.epoch, position: outcome.position });
    set.headers['cache-control'] = 'no-store';
    return outcome.value;
  });
}
