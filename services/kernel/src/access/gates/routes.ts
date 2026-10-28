import { t } from 'elysia';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { Pool } from 'pg';
import { AuthenticationError, type Access } from '../../request/access.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { customMethod } from '../../http/custom-method.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { PLATFORM_RESOURCE } from '../bootstrap-governance.ts';
import { createExposureCommands } from './catalogue.ts';
import { openApiRoutes } from './openapi-route.ts';
import { admittedGroupsRoutes } from './admitted-groups-route.ts';

const closed = { additionalProperties: false } as const;
const paramsSchema = t.Object({ group: t.String({ pattern: '^(?!(?:any|open|close)$)[a-z][a-z_-]{0,62}$' }) }, closed);
const headersSchema = t.Object({ [IDEMPOTENCY_HEADER]: t.String() });
const success = t.Object(
  { exposure: t.Object({ group: t.String(), open: t.Boolean(), changed: t.Boolean() }, closed) },
  closed,
);
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  422: problemSchema('idempotency_conflict'),
  429: problemSchema('rate_limited'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'rate_limit_unavailable',
  ),
};
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
          : { issues: [{ message: 'Value does not match the exposure schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
const detail = (operation: 'open' | 'close') => ({
  operationId: `exposure.${operation}`,
  'x-exposure': 'public',
  'x-action': `exposure:${operation}`,
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }],
});

export function exposureRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: Pool; clock: () => Date; access: () => Access },
) {
  let resolved: ReturnType<typeof createExposureCommands> | undefined;
  const commands = () => (resolved ??= createExposureCommands({ pool: dependencies.pool, clock: dependencies.clock }));

  const options = (operation: 'open' | 'close') => ({
    headers: strict(headersSchema),
    params: strict(paramsSchema),
    response: { 200: success, ...failures },
    detail: detail(operation),
  });
  const discovered = admittedGroupsRoutes(app, dependencies);
  const routed = discovered
    .post(
      customMethod('/v1/platform/exposure/:group', 'close'),
      options('close'),
      async ({ params, headers, actor, admission, job, session, authorizeCommand }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const authorization = await authorizeCommand(PLATFORM_RESOURCE, () => new ProblemError('forbidden'));
        const input = {
          group: params.group,
          key: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
          authorization,
        };
        const outcome = await admission.run('normal', job, () =>
          commands().close({ pool: dependencies.pool, actor, deadline: job.deadline }, input),
        );
        session.record(outcome);
        return { exposure: outcome.value };
      },
    )
    .post(
      customMethod('/v1/platform/exposure/:group', 'open'),
      options('open'),
      async ({ params, headers, actor, admission, job, session, authorizeCommand }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const authorization = await authorizeCommand(PLATFORM_RESOURCE, () => new ProblemError('forbidden'));
        const input = {
          group: params.group,
          key: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
          authorization,
        };
        const outcome = await admission.run('normal', job, () =>
          commands().open({ pool: dependencies.pool, actor, deadline: job.deadline }, input),
        );
        session.record(outcome);
        return { exposure: outcome.value };
      },
    );
  // The exposure chain is a later state of the same instance. The helper's parameter is the
  // composition root type, so the cast keeps that helper callable and the intersection keeps
  // both the exposure commands and the document route on the returned contract.
  const documented = openApiRoutes(routed as unknown as ReturnType<typeof definitionRoutes>, dependencies);
  return documented as typeof documented & typeof routed;
}
