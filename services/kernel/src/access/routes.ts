import { createHash } from 'node:crypto';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { createPreferenceCommands, readAccountPreferences } from './preferences.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import { normalizeHandle } from './lifecycle.ts';
import {
  readPublicAccountByHandle,
  readPublicIdentities,
  type PublicIdentity,
  type PublicAccountProfile,
} from './account-data.ts';
import { createGrantCommands, GrantDeniedError } from './grant-commands.ts';
import { createRateTierCommands, RateTierNotAppliedError } from './rate-tier.ts';
import { createReinstatementCommands, ReinstatementNotAppliedError } from './reinstatement.ts';
import { createSuspensionCommands } from './suspension.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const publicIdentity = t.Object(
  {
    id,
    kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
    handle: t.Union([t.String(), t.Null()]),
    displayName: t.Union([t.String(), t.Null()]),
    state: t.Union([t.Literal('active'), t.Literal('deleted')]),
    automated: t.Boolean(),
    operatorId: t.Union([id, t.Null()]),
  },
  closed,
);
const coverSummary = t.Object(
  {
    media: id,
    width: t.Integer({ minimum: 1 }),
    height: t.Integer({ minimum: 1 }),
    placeholder: t.Object({ thumbhash: t.String(), color: t.String() }, closed),
    variants: t.Array(
      t.Object({ format: t.Union([t.Literal('avif'), t.Literal('webp')]), width: t.Integer({ minimum: 1 }) }, closed),
    ),
    focalPoint: t.Union([
      t.Object({ x: t.Number({ minimum: 0, maximum: 1 }), y: t.Number({ minimum: 0, maximum: 1 }) }, closed),
      t.Null(),
    ]),
    credit: t.Null(),
  },
  closed,
);
const publicProfile = t.Object(
  {
    ...publicIdentity.properties,
    bio: t.Union([t.String(), t.Null()]),
    links: t.Array(
      t.Object({ label: t.String({ minLength: 1, maxLength: 64 }), url: t.String({ maxLength: 2048 }) }, closed),
      { maxItems: 5 },
    ),
    avatar: t.Union([coverSummary, t.Null()]),
    publicViews: t.Object({ posts: t.Boolean(), reviews: t.Boolean(), collections: t.Boolean() }, closed),
    speakersListed: t.Optional(t.Boolean()),
    subject: t.Union([t.Object({ id, label: t.String(), type: t.String() }, closed), t.Null()]),
  },
  closed,
);
// Named item types keep the client declaration within the compiler's serialization bound.
const publicAccountList = t.Unsafe<{ accounts: (PublicIdentity | PublicAccountProfile)[]; next: null }>(
  t.Object({ accounts: t.Array(t.Union([publicProfile, publicIdentity])), next: t.Null() }, closed),
);
const preferenceValues = {
  spoilerLevel: t.Union([t.Literal(0), t.Literal(1), t.Literal(2)]),
  suitability: t.Union([t.Literal('blur'), t.Literal('show')]),
};
const preferences = t.Object({ ...preferenceValues, version: t.Integer({ minimum: 0 }) }, closed);
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
          : { issues: [{ message: 'Value does not match the request schema' }] };
      },
      jsonSchema: { input: (): TSchema => schema, output: (): TSchema => schema },
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
const publicReadFailures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
};
const accountUuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const accountIdPattern = new RegExp(`^${accountUuidPattern}$`);
const publicIdentityQuery = t.Unsafe<{ ids: string } | { handle: string }>(
  t.Union([
    t.Object(
      {
        ids: t.String({
          minLength: 36,
          maxLength: 3699,
          pattern: `^${accountUuidPattern}(?:,${accountUuidPattern}){0,99}$`,
        }),
      },
      closed,
    ),
    t.Object(
      { handle: t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }) },
      closed,
    ),
  ]),
);
const response = <S extends TSchema>(schema: S) =>
  withHeaders(t.Object({ grant: schema }, closed), { [SESSION_HEADER]: t.String() });
const detail = (operationId: string) => ({
  operationId,
  'x-exposure': 'public',
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
  let suspension: ReturnType<typeof createSuspensionCommands> | undefined;
  const suspensionCommands = () =>
    (suspension ??= createSuspensionCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      clock: dependencies.clock,
    }));
  let reinstatement: ReturnType<typeof createReinstatementCommands> | undefined;
  const reinstatementCommands = () =>
    (reinstatement ??= createReinstatementCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      clock: dependencies.clock,
    }));
  let rateTier: ReturnType<typeof createRateTierCommands> | undefined;
  const rateTierCommands = () =>
    (rateTier ??= createRateTierCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      clock: dependencies.clock,
    }));
  let preference: ReturnType<typeof createPreferenceCommands> | undefined;
  const preferenceCommands = () =>
    (preference ??= createPreferenceCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      clock: dependencies.clock,
    }));
  return app
    .get(
      '/v1/accounts/:accountId/preferences',
      {
        params: strict(t.Object({ accountId: id }, closed)),
        response: { 200: preferences, ...failures },
        detail: {
          operationId: 'account.read_preferences',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, actor, authorize, admission, job, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (actor.accountId !== params.accountId) throw new ProblemError('forbidden');
        const check = await authorize({ route: routeOf(params.accountId)!, id: params.accountId });
        const value = await admission.run('normal', job, () =>
          withConnection(dependencies.pool, async (client) => {
            if (!(await check(client))) throw new ProblemError('forbidden');
            return readAccountPreferences(client, params.accountId);
          }),
        );
        set.headers['cache-control'] = 'private, no-store';
        return value;
      },
    )
    .patch(
      '/v1/accounts/:accountId/preferences',
      {
        headers,
        params: strict(t.Object({ accountId: id }, closed)),
        body: strict(
          t.Object(
            {
              expectedVersion: t.Integer({ minimum: 0, maximum: 2147483646 }),
              spoilerLevel: t.Optional(preferenceValues.spoilerLevel),
              suitability: t.Optional(preferenceValues.suitability),
            },
            closed,
          ),
        ),
        response: {
          200: withHeaders(preferences, { [SESSION_HEADER]: t.String() }),
          ...failures,
          409: problemSchema('conflict'),
        },
        detail: { ...detail('account.set_preferences'), 'x-action': 'account:update' },
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (actor.accountId !== params.accountId) throw new ProblemError('forbidden');
        try {
          const outcome = await admission.run('normal', job, () =>
            preferenceCommands().setPreferences(
              { pool: dependencies.pool, actor, deadline: job.deadline },
              { ...body, accountId: params.accountId, key: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]) },
            ),
          );
          session.record(outcome);
          set.headers['cache-control'] = 'private, no-store';
          return outcome.value;
        } catch (error) {
          return denied(error);
        }
      },
    )
    .get(
      '/v1/accounts',
      {
        query: strict(publicIdentityQuery),
        response: {
          200: withHeaders(publicAccountList, {
            etag: t.String(),
            'cache-control': t.String(),
          }),
          ...publicReadFailures,
        },
        detail: {
          operationId: 'account.read_public_identity',
          'x-exposure': 'public',
          'x-action': 'account:read_public_identity',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ query, admission, job, set }) => {
        const accounts = await admission.run('normal', job, async () => {
          if ('handle' in query) return readPublicAccountByHandle(dependencies.pool, normalizeHandle(query.handle));
          const requested = query.ids.split(',');
          if (
            requested.length < 1 ||
            requested.length > 100 ||
            requested.some((accountId) => !accountIdPattern.test(accountId))
          )
            throw new ProblemError('invalid_request');

          const seen = new Set<string>();
          const accountIds = requested.filter((accountId) => {
            if (seen.has(accountId)) return false;
            seen.add(accountId);
            return true;
          });
          // Account routes are the two bytes at offsets 10 and 11, as enforced by account_check.
          const routes = accountIds.map((accountId) => Number.parseInt(accountId.slice(24, 28), 16));
          return readPublicIdentities(dependencies.pool, routes, accountIds);
        });
        const body = { accounts, next: null };
        set.headers.etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
        set.headers['cache-control'] = 'no-cache';
        return body;
      },
    )
    .post(
      customMethod('/v1/accounts/:accountId', 'suspend'),
      {
        headers,
        params: strict(t.Object({ accountId: id }, closed)),
        body: strict(t.Object({ reason: t.Optional(t.String({ minLength: 1, maxLength: 2000 })) }, closed)),
        response: {
          200: withHeaders(
            t.Object(
              {
                suspension: t.Object(
                  {
                    accountId: id,
                    state: t.Literal('suspended'),
                    minimumAuthnEpoch: t.String({ pattern: '^[1-9][0-9]{0,18}$' }),
                    receiptId: id,
                  },
                  closed,
                ),
              },
              closed,
            ),
            { [SESSION_HEADER]: t.String() },
          ),
          ...failures,
        },
        detail: { ...detail('account.suspend'), 'x-action': 'account:suspend' },
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            suspensionCommands().suspend(
              { pool: dependencies.pool, actor, deadline: job.deadline },
              { accountId: params.accountId, key, ...body },
            ),
          );
          session.record(result);
          const { accountId, state, minimumAuthnEpoch, receiptId } = result.value;
          return { suspension: { accountId, state, minimumAuthnEpoch, receiptId } };
        } catch (error) {
          denied(error);
        }
      },
    )
    .post(
      customMethod('/v1/accounts/:accountId', 'reinstate'),
      {
        headers,
        params: strict(t.Object({ accountId: id }, closed)),
        body: strict(t.Object({ reason: t.Optional(t.String({ minLength: 1, maxLength: 2000 })) }, closed)),
        response: {
          200: withHeaders(
            t.Object(
              {
                reinstatement: t.Object(
                  {
                    accountId: id,
                    state: t.Literal('active'),
                    minimumAuthnEpoch: t.String({ pattern: '^[1-9][0-9]{0,18}$' }),
                    receiptId: id,
                  },
                  closed,
                ),
              },
              closed,
            ),
            { [SESSION_HEADER]: t.String() },
          ),
          ...failures,
          409: problemSchema('conflict'),
        },
        detail: { ...detail('account.reinstate'), 'x-action': 'account:reinstate' },
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            reinstatementCommands().reinstate(
              { pool: dependencies.pool, actor, deadline: job.deadline },
              { accountId: params.accountId, key, ...body },
            ),
          );
          session.record(result);
          const { accountId, state, minimumAuthnEpoch, receiptId } = result.value;
          return { reinstatement: { accountId, state, minimumAuthnEpoch, receiptId } };
        } catch (error) {
          if (error instanceof ReinstatementNotAppliedError) throw new ProblemError('conflict');
          denied(error);
        }
      },
    )
    .post(
      customMethod('/v1/accounts/:accountId', 'setRateTier'),
      {
        headers,
        params: strict(t.Object({ accountId: id }, closed)),
        body: strict(
          t.Object(
            {
              key: t.String({ minLength: 1, maxLength: 255 }),
              tier: t.Union([t.Literal('ordinary'), t.Literal('trusted'), t.Literal('service')]),
            },
            closed,
          ),
        ),
        response: {
          200: withHeaders(
            t.Object(
              {
                rateTier: t.Object(
                  {
                    accountId: id,
                    tier: t.Union([t.Literal('ordinary'), t.Literal('trusted'), t.Literal('service')]),
                    receiptId: id,
                  },
                  closed,
                ),
              },
              closed,
            ),
            { [SESSION_HEADER]: t.String() },
          ),
          ...failures,
          409: problemSchema('conflict'),
        },
        detail: { ...detail('account.set_rate_tier'), 'x-action': 'account:set_rate_tier' },
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        if (key !== body.key) throw new ProblemError('invalid_request');
        try {
          const result = await admission.run('normal', job, () =>
            rateTierCommands().setRateTier(
              { pool: dependencies.pool, actor, deadline: job.deadline },
              { accountId: params.accountId, key, tier: body.tier },
            ),
          );
          session.record(result);
          const { accountId, tier, receiptId } = result.value;
          return { rateTier: { accountId, tier, receiptId } };
        } catch (error) {
          if (error instanceof RateTierNotAppliedError) throw new ProblemError('conflict');
          denied(error);
        }
      },
    )
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
