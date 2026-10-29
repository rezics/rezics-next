import { t } from 'elysia';
import { withHeaders } from '@elysia/openapi';
import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { Access } from '../request/access.ts';
import { problemSchema } from '../http/problem.ts';
import { customMethod } from '../http/custom-method.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { actionForRequest, IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  ZoneCreateInputSchema,
  ZoneConfigureInputSchema,
  ZonePublishInputSchema,
  ZoneResponseSchema,
  ZoneMetadataResponseSchema,
  ZoneConfigurationResponseSchema,
  ZoneListSchema,
  ZonePageRequestSchema,
  ZonePageResponseSchema,
} from './contract.ts';
import { ZonePageQuerySchema, ZonePageReadProgressSchema } from './page-continuation.ts';
import { readStaticZonePage } from './page-runtime.ts';
import { createZoneCommands, zoneIfMatch } from './resource-commands.ts';
import { createZoneReads, requireZoneAccount } from './resource-reads.ts';

const closed = { additionalProperties: false } as const;
const params = t.Object({ id: t.String() }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const conditionalHeaders = t.Object({ ...headers.properties, 'if-match': t.Optional(t.String()) });
/** Keep the contract's intersected safe strings intact: Elysia's object coercion otherwise turns them
 * into empty objects. Validate original JSON and responses through the native Standard Schema port. */
function zoneSchema<S extends TSchema>(schema: S) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return validator.Check(value)
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Value does not match the Zone schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden', 'platform_closed'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict', 'stale_cursor'),
  412: problemSchema('precondition_failed'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'semantic_not_ready',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
    'dependency_unavailable',
  ),
};
function detail(operation: string, action: string, anonymous = false, write = false) {
  return {
    operationId: `zone.${operation}`,
    'x-exposure': 'public' as const,
    'x-action': action,
    security: anonymous ? [{ bearerAuth: [] }, {}] : [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
function cache(set: { headers: Record<string, string | number | readonly string[]> }, revision?: string) {
  set.headers['cache-control'] = 'private, no-store';
  if (revision) set.headers.etag = `"${revision}"`;
}
/** Resource routes and independent static pages; source-dependent execution has separate owners. */
export function zoneRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    clock: () => Date;
  },
) {
  const reads = () => createZoneReads({ ...dependencies, access: dependencies.access() });
  const commands = () => createZoneCommands({ ...dependencies, access: dependencies.access() });
  return app
    .post(
      '/v1/zones',
      {
        headers,
        body: zoneSchema(ZoneCreateInputSchema),
        response: { 201: zoneSchema(ZoneResponseSchema), ...failures },
        detail: { ...detail('create', 'zone:create', false, true), 'x-resource-types': ['semantic.zone'] },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireZoneAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () => commands().create(actor, body, key, job.deadline));
        session.record(result);
        set.status = 201;
        set.headers.location = `/v1/zones/${result.value.zone.id}`;
        cache(set, result.value.zone.revision);
        return result.value;
      },
    )
    .get(
      '/v1/zones',
      {
        query: t.Object(
          {
            limit: t.Optional(t.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
            cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
            deleted: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
          },
          closed,
        ),
        response: { 200: zoneSchema(ZoneListSchema), ...failures },
        // The native action catalogue shares zone:read's anonymous floor with metadata. This owner
        // index independently requires an authenticated account before preparing any resource reads.
        detail: {
          ...detail('list', 'zone:read', true),
          description: 'Requires an authenticated account; lists only its currently owned and readable Zones.',
        },
      },
      async ({ query, actor, admission, job, set }) => {
        requireZoneAccount(actor);
        cache(set);
        return admission.run('normal', job, () =>
          reads().list(
            actor,
            {
              ...(query.limit ? { limit: Number(query.limit) } : {}),
              ...(query.cursor ? { cursor: query.cursor } : {}),
              deleted: query.deleted === 'true',
            },
            job.deadline,
          ),
        );
      },
    )
    .get(
      '/v1/zones/:id',
      {
        params,
        response: { 200: zoneSchema(ZoneMetadataResponseSchema), ...failures },
        detail: detail('get', 'zone:read', true),
      },
      async ({ params, actor, admission, job, set }) => {
        const result = await admission.run('normal', job, () => reads().metadata(actor, params.id, job.deadline));
        cache(set, result.zone.revision);
        return { zone: result.zone };
      },
    )
    .get(
      '/v1/zones/:id/configuration',
      {
        params,
        response: { 200: zoneSchema(ZoneConfigurationResponseSchema), ...failures },
        detail: detail('get_configuration', 'zone:configure'),
      },
      async ({ params, actor, admission, job, set }) => {
        requireZoneAccount(actor);
        const result = await admission.run('normal', job, () => reads().configuration(actor, params.id, job.deadline));
        cache(set, result.zone.revision);
        return result;
      },
    )
    .post(
      customMethod('/v1/zones/:id', 'readPage'),
      {
        params,
        query: zoneSchema(ZonePageQuerySchema),
        body: zoneSchema(ZonePageRequestSchema),
        response: {
          ...failures,
          200: zoneSchema(ZonePageResponseSchema),
          202: zoneSchema(ZonePageReadProgressSchema),
          503: withHeaders(failures[503], { 'retry-after': t.String() }),
        },
        detail: detail('read_page', 'zone:read', true),
      },
      async ({ params, body, actor, request, route, admission, job, session, set }) => {
        const result = await admission.run('normal', job, () =>
          readStaticZonePage(
            { ...dependencies, access: dependencies.access() },
            {
              actor,
              id: params.id,
              body,
              request,
              clientAction: actionForRequest(app, request, route),
              dispatch: (request) => Promise.resolve(app.handle(request)),
              deadline: job.deadline,
            },
          ),
        );
        session.record(result.component);
        cache(set);
        return result.value;
      },
    )
    .put(
      '/v1/zones/:id/configuration',
      {
        params,
        headers: conditionalHeaders,
        body: zoneSchema(ZoneConfigureInputSchema),
        response: { 200: zoneSchema(ZoneResponseSchema), ...failures },
        detail: detail('configure', 'zone:configure', false, true),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireZoneAccount(actor);
        const expected = zoneIfMatch(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          commands().mutate(actor, params.id, 'configure', body, expected, key, job.deadline),
        );
        session.record(result);
        cache(set, result.value.zone.revision);
        return result.value;
      },
    )
    .post(
      customMethod('/v1/zones/:id', 'publish'),
      {
        params,
        headers: conditionalHeaders,
        body: zoneSchema(ZonePublishInputSchema),
        response: { 200: zoneSchema(ZoneResponseSchema), ...failures },
        detail: detail('publish', 'zone:publish', false, true),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireZoneAccount(actor);
        const expected = zoneIfMatch(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          commands().mutate(actor, params.id, 'publish', body, expected, key, job.deadline),
        );
        session.record(result);
        cache(set, result.value.zone.revision);
        return result.value;
      },
    )
    .delete(
      '/v1/zones/:id',
      {
        params,
        headers: conditionalHeaders,
        response: { 200: zoneSchema(ZoneResponseSchema), ...failures },
        detail: detail('delete', 'zone:delete', false, true),
      },
      async ({ params, headers, actor, admission, job, session, set }) => {
        requireZoneAccount(actor);
        const expected = zoneIfMatch(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          commands().mutate(actor, params.id, 'delete', null, expected, key, job.deadline),
        );
        session.record(result);
        cache(set, result.value.zone.revision);
        return result.value;
      },
    )
    .post(
      customMethod('/v1/zones/:id', 'restore'),
      {
        params,
        headers: conditionalHeaders,
        body: zoneSchema(t.Object({}, closed)),
        response: { 200: zoneSchema(ZoneResponseSchema), ...failures },
        detail: detail('restore', 'zone:restore', false, true),
      },
      async ({ params, headers, actor, admission, job, session, set }) => {
        requireZoneAccount(actor);
        const expected = zoneIfMatch(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          commands().mutate(actor, params.id, 'restore', null, expected, key, job.deadline),
        );
        session.record(result);
        cache(set, result.value.zone.revision);
        return result.value;
      },
    );
}
