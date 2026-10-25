import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { parseItem } from 'structured-headers';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  createSpace,
  readSpace,
  spaceReadEligibility,
  SpaceConflictError,
  SpaceInputError,
  updateSpace,
  type Space,
  type SpaceDependencies,
} from './space.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const instant = t.String({ format: 'date-time' });
const title = t.String({ minLength: 1, maxLength: 1024 });
const summary = t.String({ maxLength: 4096 });
const space = t.Object(
  {
    spaceId: id,
    state: t.Literal('active'),
    headRevisionId: id,
    createdAt: instant,
    creator: id,
    predecessor: t.Union([id, t.Null()]),
    title,
    summary,
    revisionCreatedAt: instant,
    author: id,
  },
  closed,
);
const spaceResponse = t.Object({ space }, closed);
const createInput = t.Object({ title, summary: t.Optional(summary) }, closed);
const updateInput = t.Object({ title: t.Optional(title), summary: t.Optional(summary) }, closed);

/** Standard-schema validation keeps unknown fields instead of removing them. */
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
          : { issues: [{ message: 'Value does not match the Space schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

const readFailures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
  ),
};
const writeFailures = {
  ...readFailures,
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  422: problemSchema('idempotency_conflict', 'too_many_events'),
  429: problemSchema('rate_limited'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
    'rate_limit_unavailable',
  ),
};
const sessionHeader = { [SESSION_HEADER]: t.String() };
const commandHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const updateHeaders = t.Object(
  { [IDEMPOTENCY_HEADER]: t.String(), 'if-match': t.String() },
  { additionalProperties: true },
);
const readSecurity = [{ bearerAuth: [] }, {}];
const writeSecurity = [{ bearerAuth: [] }];
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const params = t.Object({ spaceId: t.String() }, closed);

export type CommunityRouteDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  clock?: () => Date;
  access: () => Access;
};

function communityProblem(error: unknown): never {
  if (error instanceof SpaceInputError) throw new ProblemError('invalid_request');
  // A changed head is the same closed not_found as content post edit's failed compare-and-set.
  if (error instanceof SpaceConflictError) throw new ProblemError('not_found');
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  throw error;
}

function matchHead(header: string): string {
  let value: unknown;
  try {
    [value] = parseItem(header);
  } catch {
    throw new ProblemError('invalid_request');
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) throw new ProblemError('invalid_request');
  return value;
}

function published(space: Space) {
  if (space.state !== 'active') throw new ProblemError('not_found');
  return {
    spaceId: space.spaceId,
    state: 'active' as const,
    headRevisionId: space.headRevisionId,
    createdAt: space.createdAt,
    creator: space.creator,
    predecessor: space.predecessor,
    title: space.title,
    summary: space.summary,
    revisionCreatedAt: space.revisionCreatedAt,
    author: space.author,
  };
}

export function communityRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: CommunityRouteDependencies) {
  const spaceDependencies = (): SpaceDependencies => ({
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    access: dependencies.access(),
  });
  const observedAt = () => (dependencies.clock ?? (() => new Date()))().toISOString();

  return app
    .post(
      '/v1/spaces',
      {
        headers: commandHeaders,
        body: strict(createInput),
        response: {
          201: withHeaders(strict(spaceResponse), { ...sessionHeader, location: t.String(), etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'space.create',
          'x-action': 'space:create',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await createSpace(
              spaceDependencies(),
              actor,
              { title: body.title, ...(body.summary === undefined ? {} : { summary: body.summary }) },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readSpace(dependencies.pool, result.value.spaceId, observedAt());
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = published(current);
            session.record(result);
            set.status = 201;
            set.headers.location = `/v1/spaces/${representation.spaceId}`;
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { space: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/spaces/:spaceId',
      {
        params,
        response: {
          200: withHeaders(strict(spaceResponse), { etag: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'space.get',
          'x-action': 'space:read',
          security: readSecurity,
        },
      },
      async ({ params: { spaceId }, authorize, admission, job, set }) => {
        const route = routeOf(spaceId);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: spaceId };
        const check = await authorize({ ...resource, eligibility: spaceReadEligibility(resource) });
        const current = await admission.run('normal', job, () =>
          withConnection(dependencies.pool, async (client) => {
            if (!(await check(client))) return null;
            return readSpace(client, spaceId, observedAt());
          }),
        );
        if (!current) throw new ProblemError('not_found');
        const representation = published(current);
        set.headers.etag = JSON.stringify(representation.headRevisionId);
        return { space: representation };
      },
    )
    .patch(
      '/v1/spaces/:spaceId',
      {
        params,
        headers: updateHeaders,
        body: strict(updateInput),
        response: {
          200: withHeaders(strict(spaceResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'space.update',
          'x-action': 'space:manage',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { spaceId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await updateSpace(
              spaceDependencies(),
              actor,
              {
                spaceId,
                expectedHead,
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.summary === undefined ? {} : { summary: body.summary }),
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readSpace(dependencies.pool, result.value.spaceId, observedAt());
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = published(current);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { space: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    );
}
