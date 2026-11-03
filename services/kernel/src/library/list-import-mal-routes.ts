import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { customMethod } from '../http/custom-method.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createMalImport } from './list-import-mal.ts';
import { MAL_LIMITS } from './list-import-mal-parser.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' }), row = t.Integer({ minimum: 0, maximum: MAL_LIMITS.rows - 1 });
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const params = t.Object({ id }, closed);
const failures = {
  400: problemSchema('invalid_request'), 401: problemSchema('authentication_required','invalid_credentials'),
  403: problemSchema('forbidden'), 404: problemSchema('not_found'), 409: problemSchema('conflict'),
  413: problemSchema('content_too_large'), 422: problemSchema('idempotency_conflict'),
  503: problemSchema('overloaded','deadline_exceeded','partition_unavailable','transaction_retry_exhausted'),
};
const detail = (name: string) => ({ operationId: `library_mal.${name}`, 'x-action': 'library_entry:update',
  'x-exposure': 'gate:personal_library', 'x-authority-anchor': 'own-account',
  'x-authority-resource-types': Object.keys(bundledRelease.types),
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }), security: [{ bearerAuth: [] }] });
const result = t.Object({ id }, closed);
type Page = Awaited<ReturnType<ReturnType<typeof createMalImport>['page']>>;
type Applied = Awaited<ReturnType<ReturnType<typeof createMalImport>['apply']>>;

export function malImportRoutes(app: ReturnType<typeof definitionRoutes>, deps: {
  pool: Pool; access: () => Access; routeKey: Uint8Array; tokens: KeyRing; clock?: KernelClock;
}) {
  const service = () => createMalImport({ ...deps, access: deps.access() });
  async function safe<T>(body: () => Promise<T>): Promise<T> {
    try { return await body(); }
    catch (e) { if (e instanceof GrantDeniedError) throw new ProblemError('forbidden'); throw e; }
  }
  return app
    .post(customMethod('/v1/libraryImports/mal', 'preview'), {
      headers, body: t.Object({ xml: t.String({ maxLength: MAL_LIMITS.bytes }) }, closed),
      response: { 200: result, ...failures }, detail: { ...detail('preview'), 'x-body-limit': MAL_LIMITS.wireBytes },
    }, async ({ actor, body, headers, job, admission, session, set }) => safe(async () => {
      const command = await admission.run('normal',job,() => service().preview(actor,body.xml,idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),job.deadline));
      session.record(command); set.headers['Cache-Control'] = 'private, no-store'; return command.value;
    }))
    .get('/v1/libraryImports/mal/:id', {
      params, query: t.Object({ after: t.Optional(t.Integer({ minimum: 0, maximum: MAL_LIMITS.rows })) }, closed),
      response: { 200: t.Unsafe<Page>(t.Any()), ...failures }, detail: detail('page'),
    }, async ({ actor, params, query, job, admission, set }) => safe(async () => {
      set.headers['Cache-Control'] = 'private, no-store';
      return admission.run('normal',job,() => service().page(actor,params.id,query.after ?? 0,job.deadline));
    }))
    .get('/v1/libraryImports/mal/:id/source', {
      params, response: { 200: t.Object({ xml: t.String() },closed), ...failures }, detail: detail('source'),
    }, async ({ actor, params, job, admission, set }) => safe(async () => {
      set.headers['Cache-Control'] = 'private, no-store';
      return admission.run('normal',job,() => service().source(actor,params.id,job.deadline));
    }))
    .post('/v1/libraryImports/mal/:id/review', {
      params, headers, body: t.Object({ row, target: t.Union([id,t.Null()]), skip: t.Boolean(), replace: t.Boolean() }, closed),
      response: { 200: result, ...failures }, detail: detail('review'),
    }, async ({ actor, params, body, headers, job, admission, session, set }) => safe(async () => {
      const command = await admission.run('normal',job,() => service().review(actor,params.id,body,idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),job.deadline));
      session.record(command); set.headers['Cache-Control'] = 'private, no-store'; return command.value;
    }))
    .post('/v1/libraryImports/mal/:id/apply', {
      params, body: t.Object({ confirm: t.Literal(true), rows: t.Array(t.Object({ row,
        version: t.String({ minLength: 1, maxLength: 1024 }), fields: t.Array(t.String({ maxLength: 128 }), { maxItems: 64, uniqueItems: true }) }, closed),
        { minItems: 1, maxItems: MAL_LIMITS.page, uniqueItems: true }) }, closed),
      response: { 200: t.Unsafe<Applied>(t.Any()), ...failures }, detail: detail('apply'),
    }, async ({ actor, params, body, request, job, admission, session, set }) => safe(async () => {
      set.headers['Cache-Control'] = 'private, no-store';
      if (new Set(body.rows.map(r => r.row)).size !== body.rows.length) throw new ProblemError('invalid_request');
      return admission.run('normal',job,() => service().apply(actor,params.id,body,job.deadline,request.signal,v => session.record(v)));
    }))
    .post('/v1/libraryImports/mal/:id/cancel', {
      params, headers, body: t.Object({},closed), response: { 200: result, ...failures }, detail: detail('cancel'),
    }, async ({ actor, params, headers, job, admission, session }) => safe(async () => {
      const command = await admission.run('normal',job,() => service().cancel(actor,params.id,idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])));
      session.record(command); return command.value;
    }))
    .delete('/v1/libraryImports/mal/:id', {
      params, headers, response: { 200: result, ...failures }, detail: detail('delete'),
    }, async ({ actor, params, headers, job, admission, session }) => safe(async () => {
      const command = await admission.run('normal',job,() => service().delete(actor,params.id,idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])));
      session.record(command); return command.value;
    }));
}
