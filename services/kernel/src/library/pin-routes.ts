import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { KernelClock } from '../clock.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { collectionSchema } from './collection-routes.ts';
import { createPins } from './pins.ts';

const closed = { additionalProperties: false } as const;
const revision = t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const result = t.Object({ revision }, closed);
const id = t.String();
const params = t.Object({ collectionId: id }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden', 'platform_closed'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict', 'collection_full', 'stale_cursor'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
    'semantic_not_ready',
    'presentation_not_ready',
  ),
};
function detail(operation: string, action: string, write = false) {
  return {
    operationId: `library_pin.${operation}`,
    'x-action': `library_pin:${action}`,
    'x-exposure': 'gate:personal_library',
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
function strict<S extends TSchema>(schema: S) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return validator.Check(value)
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Value does not match the pin schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
function queryFields(request: Request, allowed: string[]) {
  for (const key of new URL(request.url).searchParams.keys())
    if (!allowed.includes(key)) throw new ProblemError('invalid_request');
}

/** Lazy Access is resolved only after kernel composition and native route admission. */
export function pinRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    clock: KernelClock;
  },
) {
  const pins = () => createPins({ ...deps, access: deps.access() });
  return app
    .get(
      '/v1/libraryPins',
      {
        query: t.Object(
          {
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
          },
          closed,
        ),
        transform: ({ request }) => queryFields(request, ['limit', 'cursor']),
        response: {
          200: t.Object(
            {
              pins: t.Array(t.Object({ collectionId: id, target: t.Union([collectionSchema, t.Null()]) }, closed)),
              revision,
              next: t.Union([t.String(), t.Null()]),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('list', 'list'),
      },
      async ({ actor, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => pins().list(actor, query));
      },
    )
    .put(
      '/v1/libraryPins/:collectionId',
      {
        params,
        headers,
        body: strict(t.Object({ revision, after: t.Optional(t.Union([id, t.Null()])) }, closed)),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: result, ...failures },
        detail: detail('put', 'update', true),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const command = await admission.run('normal', job, () => pins().mutate(actor, params.collectionId, body, key));
        session.record({ partition: command.partition, epoch: command.epoch, position: command.position });
        return command.value;
      },
    )
    .delete(
      '/v1/libraryPins/:collectionId',
      {
        params,
        headers,
        query: t.Object(
          { revision: t.Numeric({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }) },
          closed,
        ),
        transform: ({ request }) => queryFields(request, ['revision']),
        response: { 200: result, ...failures },
        detail: detail('delete', 'update', true),
      },
      async ({ actor, params, query, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const command = await admission.run('normal', job, () =>
          pins().mutate(actor, params.collectionId, query, key, true),
        );
        session.record({ partition: command.partition, epoch: command.epoch, position: command.position });
        return command.value;
      },
    );
}
