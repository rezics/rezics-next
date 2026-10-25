import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import { createGrantCommands, GrantDeniedError } from './grant-commands.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const resource = t.Object({ route: t.Integer({ minimum: 0, maximum: 65535 }), id }, closed);
const subject = t.Union([
  t.Object({ kind: t.Literal('active_accounts') }, closed),
  t.Object({ kind: t.Literal('account'), id }, closed),
  t.Object({ kind: t.Literal('organization'), id, role: t.Union([t.Literal('owner'), t.Literal('member')]) }, closed),
]);
const actions = t.Array(t.String({ pattern: '^[a-z][a-z_]*:[a-z][a-z_]*$' }), { minItems: 1, maxItems: 1000 });
const valid = t.String();
const direct = { resource, actions, valid };
const canonical = { subject };
const legacy = { subjectId: id, subjectRole: t.Union([t.Literal(''), t.Literal('owner'), t.Literal('member')]) };
const previous = t.Object({ actions, valid }, closed);
const grant = t.Union([t.Object({ ...direct, ...canonical }, closed), t.Object({ ...direct, ...legacy }, closed)]);
const grantChange = t.Union([
  t.Object({ ...direct, ...canonical, previous }, closed),
  t.Object({ ...direct, ...legacy, previous }, closed),
]);
const role = t.String();
const roleGrant = t.Object({ resource, subject, role, valid }, closed);
const roleChange = t.Object({ resource, subject, role, valid, previous: t.Object({ role, valid }, closed) }, closed);

function publicGrant(value: Static<typeof grant>): Static<typeof grant> {
  return {
    resource: { route: value.resource.route, id: value.resource.id },
    ...('subject' in value
      ? { subject: value.subject }
      : { subjectId: value.subjectId, subjectRole: value.subjectRole }),
    actions: value.actions,
    valid: value.valid,
  };
}
function publicRoleGrant(value: Static<typeof roleGrant>): Static<typeof roleGrant> {
  return {
    resource: { route: value.resource.route, id: value.resource.id },
    subject: value.subject,
    role: value.role,
    valid: value.valid,
  };
}

/** Standard-schema validation preserves closed unions instead of sanitizing unknown fields. */
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
          : { issues: [{ message: 'Value does not match the grant schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() });
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
const response = <S extends TSchema>(schema: S) =>
  withHeaders(t.Object({ grant: schema }, closed), { [SESSION_HEADER]: t.String() });
const detail = (operationId: string) => ({
  operationId,
  'x-action': 'access:grant',
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }],
});
function denied(error: unknown): never {
  // PostgreSQL rejects invalid temporal values/identities and conflicting grants.
  // Neither those failures nor native formula denials disclose stored grant state.
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (error instanceof GrantDeniedError || /^(?:22|23)/.test(code)) throw new ProblemError('forbidden');
  throw error;
}

export function accessRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: Pool; access: () => Access; clock: () => Date },
) {
  let resolved: ReturnType<typeof createGrantCommands> | undefined;
  const commands = () =>
    (resolved ??= createGrantCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      clock: dependencies.clock,
      managementAction: 'access:grant',
    }));
  return app
    .post(
      '/v1/grants',
      { headers, body: strict(grant), response: { 201: response(grant), ...failures }, detail: detail('grant.create') },
      async ({ body, headers, actor, admission, job, session, status }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            commands().create({ pool: dependencies.pool, actor, deadline: job.deadline }, { ...body, key }),
          );
          session.record(result);
          return status(201, { grant: publicGrant(result.value) });
        } catch (error) {
          denied(error);
        }
      },
    )
    .post(
      customMethod('/v1/grants', 'change'),
      {
        headers,
        body: strict(grantChange),
        response: { 200: response(grant), ...failures },
        detail: detail('grant.change'),
      },
      async ({ body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            commands().change({ pool: dependencies.pool, actor, deadline: job.deadline }, { ...body, key }),
          );
          session.record(result);
          return { grant: publicGrant(result.value) };
        } catch (error) {
          denied(error);
        }
      },
    )
    .post(
      customMethod('/v1/grants', 'revoke'),
      { headers, body: strict(grant), response: { 200: response(grant), ...failures }, detail: detail('grant.revoke') },
      async ({ body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            commands().revoke({ pool: dependencies.pool, actor, deadline: job.deadline }, { ...body, key }),
          );
          session.record(result);
          return { grant: publicGrant(result.value) };
        } catch (error) {
          denied(error);
        }
      },
    )
    .post(
      '/v1/roleGrants',
      {
        headers,
        body: strict(roleGrant),
        response: { 201: response(roleGrant), ...failures },
        detail: detail('role_grant.create'),
      },
      async ({ body, headers, actor, admission, job, session, status }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            commands().createRole({ pool: dependencies.pool, actor, deadline: job.deadline }, { ...body, key }),
          );
          session.record(result);
          return status(201, { grant: publicRoleGrant(result.value) });
        } catch (error) {
          denied(error);
        }
      },
    )
    .post(
      customMethod('/v1/roleGrants', 'change'),
      {
        headers,
        body: strict(roleChange),
        response: { 200: response(roleGrant), ...failures },
        detail: detail('role_grant.change'),
      },
      async ({ body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            commands().changeRole({ pool: dependencies.pool, actor, deadline: job.deadline }, { ...body, key }),
          );
          session.record(result);
          return { grant: publicRoleGrant(result.value) };
        } catch (error) {
          denied(error);
        }
      },
    )
    .post(
      customMethod('/v1/roleGrants', 'revoke'),
      {
        headers,
        body: strict(roleGrant),
        response: { 200: response(roleGrant), ...failures },
        detail: detail('role_grant.revoke'),
      },
      async ({ body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            commands().revokeRole({ pool: dependencies.pool, actor, deadline: job.deadline }, { ...body, key }),
          );
          session.record(result);
          return { grant: publicRoleGrant(result.value) };
        } catch (error) {
          denied(error);
        }
      },
    );
}
