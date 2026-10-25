import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { parseItem } from 'structured-headers';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { normalizeHandle } from '../access/lifecycle.ts';
import { withConnection } from '../database/pool.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access, type AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
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
import { claimSpaceAddress, readSpaceAddress, SpaceAddressConflictError } from './space-address.ts';
import { createRealm, RealmConflictError, RealmInputError, updateRealm, type RealmDependencies } from './realm.ts';
import { readRealm, setBoardScheme, type Realm } from './board-scheme.ts';
import { createRealmParticipationCheck } from './participation.ts';
import { enqueueRealmJoin, enqueueRealmLeave, readOwnRealmMembership, RealmMembershipConflictError } from './join.ts';
import { banAccount, unbanAccount, listBans, RealmBanInputError } from './ban.ts';
import { readRealmMembershipInterval } from './membership.ts';
import {
  listPublications,
  publish,
  PublicationConflictError,
  PublicationCursorError,
  PublicationInputError,
  readPublication,
  reject,
  withdraw,
  type PublicationHead,
  type PublicationResult,
} from './publication.ts';

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
    address: t.Union([t.String(), t.Null()]),
    title,
    summary,
    revisionCreatedAt: instant,
    author: id,
  },
  closed,
);
const spaceResponse = t.Object({ space }, closed);
const realm = t.Object(
  {
    realmId: id,
    spaceId: id,
    state: t.Literal('active'),
    visibility: t.Union([t.Literal('public'), t.Literal('protected')]),
    contextId: id,
    boardSchemeId: t.Union([id, t.Null()]),
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
const realmResponse = t.Object({ realm }, closed);
const publicationFields = {
  realmId: id,
  subjectId: id,
  publicationId: id,
  subjectRevisionId: t.Null(),
  publishedAt: instant,
};
const publication = t.Object({ ...publicationFields, verdict: t.Literal('adopt') }, closed);
const publicationResponse = t.Object({ publication }, closed);
const decisionResponse = t.Object(
  {
    publication: t.Object(
      {
        ...publicationFields,
        verdict: t.Union([t.Literal('withdraw'), t.Literal('reject')]),
        predecessor: t.Union([id, t.Null()]),
      },
      closed,
    ),
  },
  closed,
);
const publicationPage = t.Object({ items: t.Array(publication), next: t.Union([t.String(), t.Null()]) }, closed);
const accepted = t.Object({ workflowId: t.String({ minLength: 1, maxLength: 200 }) }, closed);
const membershipState = t.Object(
  {
    state: t.Union([t.Literal('none'), t.Literal('pending'), t.Literal('member')]),
    since: t.Union([instant, t.Null()]),
  },
  closed,
);
const addMemberInput = t.Object({ accountId: id }, closed);
const publicationParams = t.Object({ realmId: t.String(), subjectId: t.String() }, closed);

const createInput = t.Object({ title, summary: t.Optional(summary) }, closed);
const updateInput = t.Object({ title: t.Optional(title), summary: t.Optional(summary) }, closed);
const addressInput = t.Object({ address: t.String({ minLength: 1, maxLength: 64 }) }, closed);
const createRealmInput = t.Object(
  {
    spaceId: id,
    title,
    summary: t.Optional(summary),
    visibility: t.Union([t.Literal('public'), t.Literal('protected')]),
    contextId: id,
  },
  closed,
);
const updateRealmInput = t.Object(
  {
    title: t.Optional(title),
    summary: t.Optional(summary),
    visibility: t.Optional(t.Union([t.Literal('public'), t.Literal('protected')])),
    contextId: t.Optional(id),
  },
  closed,
);

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
          : { issues: [{ message: 'Value does not match the community request schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

const banParams = t.Object({ realmId: t.String(), accountId: id }, closed);
const banRecord = t.Object({ accountId: id, reason: t.String({ maxLength: 1024 }), actor: id, at: t.String() }, closed);
const banResponse = t.Object(
  { ban: t.Object({ ...banRecord.properties, realmId: id, workflowId: t.Union([t.String(), t.Null()]) }, closed) },
  closed,
);
const banPage = t.Object({ items: t.Array(banRecord), next: t.Union([t.String(), t.Null()]) }, closed);
const banQuery = t.Object(
  { limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })), cursor: t.Optional(t.String()) },
  closed,
);

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
const addressParams = t.Object({ address: t.String() }, closed);
const realmParams = t.Object({ realmId: t.String() }, closed);

export type CommunityRouteDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  clock?: () => Date;
  access: () => Access;
  tokens: KeyRing;
  workClient: () => Promise<WorkClient>;
};

function communityProblem(error: unknown): never {
  if (error instanceof RealmBanInputError) throw new ProblemError('invalid_request');
  if (error instanceof SpaceInputError) throw new ProblemError('invalid_request');
  if (error instanceof SpaceAddressConflictError) throw new ProblemError('conflict');
  if (error instanceof RealmInputError || error instanceof PublicationInputError)
    throw new ProblemError('invalid_request');
  if (error instanceof PublicationCursorError)
    throw new ProblemError(error.reason === 'stale' ? 'stale_cursor' : 'invalid_cursor');
  if (error instanceof PublicationConflictError) throw new ProblemError('not_found');
  // A changed head is the same closed not_found as content post edit's failed compare-and-set.
  if (error instanceof SpaceConflictError || error instanceof RealmConflictError) throw new ProblemError('not_found');
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  if (error instanceof RealmMembershipConflictError) throw new ProblemError('idempotency_conflict');
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
    address: space.address,
    title: space.title,
    summary: space.summary,
    revisionCreatedAt: space.revisionCreatedAt,
    author: space.author,
  };
}

function publishedRealm(value: Realm) {
  if (value.state !== 'active') throw new ProblemError('not_found');
  return {
    realmId: value.realmId,
    spaceId: value.spaceId,
    state: 'active' as const,
    visibility: value.visibility as 'public' | 'protected',
    contextId: value.contextId,
    boardSchemeId: value.boardSchemeId,
    headRevisionId: value.headRevisionId,
    createdAt: value.createdAt,
    creator: value.creator,
    predecessor: value.predecessor,
    title: value.title,
    summary: value.summary,
    revisionCreatedAt: value.revisionCreatedAt,
    author: value.author,
  };
}

function publishedPublication(value: PublicationHead | PublicationResult) {
  return {
    realmId: value.realmId,
    subjectId: value.subjectId,
    publicationId: value.publicationId,
    verdict: 'adopt' as const,
    subjectRevisionId: null,
    publishedAt: new Date(value.publishedAt).toISOString(),
  };
}

export function communityRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: CommunityRouteDependencies) {
  const spaceDependencies = (): SpaceDependencies => ({
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    access: dependencies.access(),
  });
  const realmDependencies = (): RealmDependencies => ({
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    access: dependencies.access(),
  });
  const banDependencies = () => ({
    ...realmDependencies(),
    tokens: dependencies.tokens,
    workClient: dependencies.workClient,
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
          'x-exposure': 'public',
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
          'x-exposure': 'public',
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
    .put(
      '/v1/spaces/:spaceId/address',
      {
        params,
        headers: updateHeaders,
        body: strict(addressInput),
        response: {
          200: withHeaders(strict(spaceResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          409: problemSchema('conflict'),
        },
        detail: {
          operationId: 'space_address.change',
          'x-exposure': 'public',
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
            const result = await claimSpaceAddress(
              spaceDependencies(),
              actor,
              { spaceId, expectedHead, address: body.address },
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
    )
    .get(
      '/v1/spaceAddresses/:address',
      {
        params: addressParams,
        response: {
          200: strict(t.Object({ spaceId: id }, closed)),
          ...readFailures,
        },
        detail: {
          operationId: 'space_address.resolve',
          'x-exposure': 'public',
          'x-action': 'space:read',
          security: readSecurity,
        },
      },
      async ({ params: { address }, authorize, admission, job }) => {
        let normalized: string;
        try {
          normalized = normalizeHandle(address);
        } catch {
          throw new ProblemError('not_found');
        }
        const current = await admission.run('normal', job, async () => {
          const claim = await withConnection(dependencies.pool, (client) => readSpaceAddress(client, normalized));
          if (!claim) return null;
          const route = routeOf(claim.spaceId);
          if (route === null) return null;
          const resource = { route, id: claim.spaceId };
          const check = await authorize({ ...resource, eligibility: spaceReadEligibility(resource) });
          return withConnection(dependencies.pool, async (client) => {
            if (!(await check(client))) return null;
            const space = await readSpace(client, claim.spaceId, observedAt());
            return space?.address === normalized ? space : null;
          });
        });
        if (!current) throw new ProblemError('not_found');
        published(current);
        return { spaceId: current.spaceId };
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
          'x-exposure': 'public',
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
    )
    .post(
      '/v1/realms',
      {
        headers: commandHeaders,
        body: strict(createRealmInput),
        response: {
          201: withHeaders(strict(realmResponse), { ...sessionHeader, location: t.String(), etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'realm.create',
          'x-exposure': 'public',
          'x-action': 'realm:create',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await createRealm(
              realmDependencies(),
              actor,
              {
                spaceId: body.spaceId,
                title: body.title,
                ...(body.summary === undefined ? {} : { summary: body.summary }),
                visibility: body.visibility,
                contextId: body.contextId,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readRealm(realmDependencies(), actor, result.value.realmId, {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = publishedRealm(current);
            session.record(result);
            set.status = 201;
            set.headers.location = `/v1/realms/${representation.realmId}`;
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { realm: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId',
      {
        params: realmParams,
        response: {
          200: withHeaders(strict(realmResponse), { etag: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'realm.get',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        const current = await admission.run('normal', job, () =>
          readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline }),
        );
        if (!current) throw new ProblemError('not_found');
        const representation = publishedRealm(current);
        set.headers.etag = JSON.stringify(representation.headRevisionId);
        return { realm: representation };
      },
    )
    .get(
      '/v1/realms/:realmId/participation',
      {
        params: realmParams,
        response: {
          204: t.Void(),
          ...readFailures,
          403: problemSchema('forbidden'),
          429: problemSchema('rate_limited'),
          503: problemSchema(
            'overloaded',
            'deadline_exceeded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'dependency_unavailable',
            'rate_limit_unavailable',
          ),
        },
        detail: {
          operationId: 'realm.participation',
          'x-exposure': 'public',
          'x-action': 'realm:participate',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        const allowed = await admission.run('normal', job, () =>
          createRealmParticipationCheck({ pool: dependencies.pool, access: dependencies.access() })(
            dependencies.pool as unknown as AccessClient,
            { realmId, actor },
          ),
        );
        if (!allowed) {
          const readable = await admission.run('normal', job, () =>
            readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline }),
          );
          if (!readable) throw new ProblemError('not_found');
          throw new ProblemError('forbidden');
        }
        set.status = 204;
      },
    )
    .patch(
      '/v1/realms/:realmId',
      {
        params: realmParams,
        headers: updateHeaders,
        body: strict(updateRealmInput),
        response: {
          200: withHeaders(strict(realmResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'realm.update',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await updateRealm(
              realmDependencies(),
              actor,
              {
                realmId,
                expectedHead,
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.summary === undefined ? {} : { summary: body.summary }),
                ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
                ...(body.contextId === undefined ? {} : { contextId: body.contextId }),
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readRealm(realmDependencies(), actor, result.value.realmId, {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = publishedRealm(current);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { realm: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .put(
      '/v1/realms/:realmId/boardScheme',
      {
        params: realmParams,
        headers: updateHeaders,
        body: strict(t.Object({ schemeId: id }, closed)),
        response: {
          200: withHeaders(strict(realmResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'realm.board_scheme',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await setBoardScheme(
              realmDependencies(),
              actor,
              {
                realmId,
                expectedHead,
                schemeId: body.schemeId,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readRealm(realmDependencies(), actor, result.value.realmId, {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = publishedRealm(current);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { realm: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms/:realmId/publications',
      {
        params: realmParams,
        headers: commandHeaders,
        body: strict(t.Object({ subjectId: id }, closed)),
        response: {
          201: withHeaders(strict(publicationResponse), { ...sessionHeader, location: t.String(), etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'publication.publish',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await publish(
              realmDependencies(),
              actor,
              { realmId, subjectId: body.subjectId },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            set.status = 201;
            set.headers.location = `/v1/realms/${realmId}/publications/${body.subjectId}`;
            set.headers.etag = JSON.stringify(result.value.publicationId);
            return { publication: publishedPublication(result.value) };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/publications',
      {
        params: realmParams,
        query: t.Object(
          {
            cursor: t.Optional(t.String()),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
          },
          closed,
        ),
        response: {
          200: strict(publicationPage),
          ...readFailures,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'publication.list',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job }) => {
        try {
          const page = await admission.run('normal', job, () =>
            listPublications(
              realmDependencies(),
              realmId,
              { actor, deadline: job.deadline },
              {
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: query.limit }),
              },
            ),
          );
          if (!page) throw new ProblemError('not_found');
          return { items: page.items.map(publishedPublication), next: page.next };
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/publications/:subjectId',
      {
        params: publicationParams,
        response: {
          200: withHeaders(strict(publicationResponse), { etag: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'publication.get',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          security: readSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, actor, admission, job, set }) => {
        const current = await admission.run('normal', job, () =>
          readPublication(realmDependencies(), realmId, subjectId, { actor, deadline: job.deadline }),
        );
        if (!current) throw new ProblemError('not_found');
        set.headers.etag = JSON.stringify(current.publicationId);
        return { publication: publishedPublication(current) };
      },
    )
    .post(
      customMethod('/v1/realms/:realmId/publications/:subjectId', 'withdraw'),
      {
        params: publicationParams,
        headers: updateHeaders,
        response: {
          200: withHeaders(strict(decisionResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'publication.withdraw',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await withdraw(
              realmDependencies(),
              actor,
              { realmId, subjectId, expectedHead },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            set.headers.etag = JSON.stringify(result.value.publicationId);
            return {
              publication: {
                ...result.value,
                verdict: 'withdraw' as const,
                publishedAt: new Date(result.value.publishedAt).toISOString(),
              },
            };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      customMethod('/v1/realms/:realmId/publications/:subjectId', 'reject'),
      {
        params: publicationParams,
        headers: updateHeaders,
        response: {
          200: withHeaders(strict(decisionResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'publication.reject',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await reject(
              realmDependencies(),
              actor,
              { realmId, subjectId, expectedHead },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            set.headers.etag = JSON.stringify(result.value.publicationId);
            return {
              publication: {
                ...result.value,
                verdict: 'reject' as const,
                publishedAt: new Date(result.value.publishedAt).toISOString(),
              },
            };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms/:realmId/membership',
      {
        params: realmParams,
        headers: commandHeaders,
        response: { 202: strict(accepted), ...writeFailures },
        detail: {
          operationId: 'realm.join',
          'x-exposure': 'public',
          'x-action': 'realm:join',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, headers, actor, admission, job, authorize, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(realmId);
        if (route === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const current = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!current) throw new ProblemError('not_found');
            if (current.visibility !== 'public') throw new ProblemError('forbidden');
            const allowed = await authorize({ route, id: realmId });
            if (!(await withConnection(dependencies.pool, (client) => allowed(client))))
              throw new ProblemError('forbidden');
            const result = await enqueueRealmJoin(await dependencies.workClient(), {
              tokens: dependencies.tokens,
              actor,
              realmId,
              spaceId: current.spaceId,
              memberAccountId: actor.accountId,
              idempotencyKey: key,
            });
            set.status = 202;
            return result;
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .delete(
      '/v1/realms/:realmId/membership',
      {
        params: realmParams,
        response: { 202: strict(accepted), ...writeFailures },
        detail: {
          operationId: 'realm.leave',
          'x-exposure': 'public',
          'x-action': 'realm:join',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(realmId) === null) throw new ProblemError('not_found');
        try {
          return await admission.run('normal', job, async () => {
            const interval = await readRealmMembershipInterval(
              dependencies.pool,
              realmId,
              actor.accountId,
              observedAt(),
            );
            if (!interval) throw new ProblemError('not_found');
            const current = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!current) throw new ProblemError('not_found');
            const result = await enqueueRealmLeave(await dependencies.workClient(), {
              tokens: dependencies.tokens,
              actor,
              realmId,
              spaceId: current.spaceId,
              reservationId: interval.reservationId,
            });
            set.status = 202;
            return result;
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms/:realmId/members',
      {
        params: realmParams,
        headers: commandHeaders,
        body: strict(addMemberInput),
        response: { 202: strict(accepted), ...writeFailures },
        detail: {
          operationId: 'realm.add_member',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, authorize, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(body.accountId) === null) throw new ProblemError('invalid_request');
        const route = routeOf(realmId);
        if (route === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const allowed = await authorize({ route, id: realmId });
            const granted = await withConnection(dependencies.pool, (client) => allowed(client));
            const current = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!granted) {
              if (!current) throw new ProblemError('not_found');
              throw new ProblemError('forbidden');
            }
            if (!current) throw new ProblemError('not_found');
            const result = await enqueueRealmJoin(await dependencies.workClient(), {
              tokens: dependencies.tokens,
              actor,
              realmId,
              spaceId: current.spaceId,
              memberAccountId: body.accountId,
              idempotencyKey: key,
            });
            set.status = 202;
            return result;
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/members/me',
      {
        params: realmParams,
        response: { 200: strict(membershipState), ...readFailures, 403: problemSchema('forbidden') },
        detail: {
          operationId: 'realm.membership',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(realmId) === null) throw new ProblemError('not_found');
        const current = await admission.run('normal', job, () =>
          readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline }),
        );
        if (!current) throw new ProblemError('not_found');
        return readOwnRealmMembership(dependencies.pool, realmId, actor.accountId, observedAt());
      },
    )
    .put(
      '/v1/realms/:realmId/bans/:accountId',
      {
        params: banParams,
        headers: commandHeaders,
        body: strict(t.Object({ reason: t.String({ maxLength: 1024 }) }, closed)),
        response: { 200: withHeaders(strict(banResponse), sessionHeader), ...writeFailures },
        detail: {
          operationId: 'realm.ban',
          'x-exposure': 'public',
          'x-action': 'realm:ban',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await banAccount(
              banDependencies(),
              actor,
              { ...params, reason: body.reason },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            return { ban: result.value };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .delete(
      '/v1/realms/:realmId/bans/:accountId',
      {
        params: banParams,
        headers: commandHeaders,
        response: { 204: t.Void(), ...writeFailures },
        detail: {
          operationId: 'realm.unban',
          'x-exposure': 'public',
          'x-action': 'realm:ban',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          await admission.run('normal', job, async () => {
            const result = await unbanAccount(banDependencies(), actor, params, {
              idempotencyKey: key,
              deadline: job.deadline,
            });
            session.record(result);
          });
          set.status = 204;
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/bans',
      {
        params: realmParams,
        query: banQuery,
        response: {
          200: strict(banPage),
          ...readFailures,
          403: problemSchema('forbidden'),
          429: problemSchema('rate_limited'),
          503: writeFailures[503],
        },
        detail: {
          operationId: 'realm.bans',
          'x-exposure': 'public',
          'x-action': 'realm:ban',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        try {
          return await admission.run('normal', job, () =>
            listBans(banDependencies(), actor, realmId, { deadline: job.deadline }, query),
          );
        } catch (error) {
          communityProblem(error);
        }
      },
    );
}
