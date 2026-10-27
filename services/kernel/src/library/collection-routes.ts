import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { SitemapQuerySchema, SitemapBoardPageSchema } from '../content/schemas.ts';
import type { KernelClock } from '../clock.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Collection, CollectionMember } from './collection-model.ts';
import { createCollectionReads } from './collection-reads.ts';
import { createCollectionCommands } from './collections.ts';
import { listSitemapCollections } from './sitemap.ts';

import { basicQuery, curatorFields, embedded, fullMembers, fullView, subjectFields, viewQuery } from './views.ts';

type Dependencies = { pool: Pool; access: () => Access; tokens: KeyRing; clock: KernelClock };
const closed = { additionalProperties: false } as const;
// Domain commands and reads distinguish malformed resource IDs from malformed JSON.
const id = t.String();
const nullableString = t.Union([t.String(), t.Null()]);
const visibility = t.Union([t.Literal('private'), t.Literal('unlisted'), t.Literal('public')]);
const revision = t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const collectionSchema = t.Object(
  {
    id,
    curatorAccountId: id,
    title: t.String(),
    description: nullableString,
    visibility,
    revision,
    memberCount: t.Integer(),
    createdAt: t.String(),
    updatedAt: t.String(),
  },
  closed,
);
const memberSchema = t.Object({ id, subjectId: id, note: nullableString, addedAt: t.String() }, closed);
const collectionResponse = t.Object({ collection: collectionSchema }, closed);
const memberResponse = t.Object({ member: memberSchema }, closed);
const subjectPage = t.Object(
  {
    collections: t.Array(
      t.Object(
        {
          id,
          curatorAccountId: id,
          title: t.String(),
          multiplicity: t.Integer({ minimum: 1 }),
        },
        closed,
      ),
    ),
    count: t.Object({ value: t.Integer({ minimum: 0 }), exact: t.Literal(true) }, closed),
    next: nullableString,
  },
  closed,
);
const fullSubjectPage = t.Object(
  {
    ...subjectPage.properties,
    collections: t.Array(embedded(subjectPage.properties.collections.items, curatorFields)),
  },
  closed,
);
const collectionParams = t.Object({ collectionId: id }, closed);
const memberParams = t.Object({ collectionId: id, memberId: id }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const pageQuery = {
  ...viewQuery,
  cursor: t.Optional(t.String({ maxLength: 4096 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
};
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict', 'collection_full', 'stale_cursor'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};
const writeRate = defineRateLimit({ family: 'write', units: 1 });
function detail(operationId: string, action: string, anonymous = false) {
  return {
    operationId,
    'x-exposure': 'gate:collections',
    'x-action': action,
    security: anonymous ? [{ bearerAuth: [] }, {}] : [{ bearerAuth: [] }],
    ...(anonymous ? {} : { 'x-rate-limit': writeRate }),
  };
}

/** Validate original JSON without Elysia's removal of undeclared body properties. */
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
          : { issues: [{ message: 'Value does not match the Collection schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
function requireAccount(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
}
async function mapped<T>(run: () => Promise<T>, denied: 'forbidden' | 'not_found' = 'not_found'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError(denied);
    throw error;
  }
}
function collectionView(value: Collection) {
  const { id, curatorAccountId, title, description, visibility, revision, memberCount, createdAt, updatedAt } = value;
  return { id, curatorAccountId, title, description, visibility, revision, memberCount, createdAt, updatedAt };
}
function memberView(value: CollectionMember) {
  const { id, subjectId, note, addedAt } = value;
  return { id, subjectId, note, addedAt };
}

/** Transport only: the merged commands and reads own authorization, privacy and ordering. */
export function collectionRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const { pool, tokens, clock } = dependencies;
  let commands: ReturnType<typeof createCollectionCommands> | undefined;
  let reads: ReturnType<typeof createCollectionReads> | undefined;
  const viewDependencies = () => ({ ...dependencies, access: dependencies.access() });
  const write = () => (commands ??= createCollectionCommands({ pool, access: dependencies.access(), clock }));
  const read = () => (reads ??= createCollectionReads({ pool, access: dependencies.access(), tokens }));
  const sitemapQuery = strict(SitemapQuerySchema);
  return app
    .get(
      '/v1/sitemap/collections',
      {
        query: SitemapQuerySchema,
        transform: ({ query }) => {
          if ('issues' in sitemapQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: strict(SitemapBoardPageSchema), ...failures },
        detail: {
          operationId: 'sitemap_collections.list',
          description:
            'Anonymous Collection sitemap feed in immutable route/id order. Each page visits at most four partitions and fetches at most 4 × limit candidates. Follow next through short or empty pages until null. lastModified is the stored Collection updated_at; external subject rendering changes do not advance it.',
          'x-exposure': 'public',
          'x-action': 'collection:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ query, admission, job }) =>
        admission.run('normal', job, () =>
          listSitemapCollections({ pool, tokens, clock, access: dependencies.access() }, job.deadline, query),
        ),
    )
    .post(
      '/v1/collections',
      {
        headers,
        body: strict(t.Object({ title: t.String(), description: t.Optional(nullableString), visibility }, closed)),
        response: { 201: collectionResponse, ...failures },
        detail: { ...detail('collection.create', 'collection:create'), 'x-resource-types': ['library.collection'] },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().createCollection(actor, body, key), 'forbidden'),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return { collection: collectionView(result.value) };
      },
    )
    .get(
      '/v1/collections',
      {
        query: t.Object({ curatorAccountId: id, ...pageQuery }, closed),
        response: {
          200: t.Object(
            { collections: t.Array(embedded(collectionSchema, curatorFields)), next: nullableString },
            closed,
          ),
          ...failures,
        },
        detail: detail('collection.list', 'collection:read', true),
      },
      async ({ query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          fullView(viewDependencies(), actor, query.view, await read().listCollections(actor, basicQuery(query))),
        ),
    )
    .get(
      '/v1/accounts/:accountId/collections',
      {
        params: t.Object({ accountId: id }, closed),
        query: t.Object(pageQuery, closed),
        response: {
          200: t.Object(
            { collections: t.Array(embedded(collectionSchema, curatorFields)), next: nullableString },
            closed,
          ),
          ...failures,
        },
        detail: detail('account.collections', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          fullView(
            viewDependencies(),
            actor,
            query.view,
            await read().listAccountCollections(actor, { curatorAccountId: params.accountId, ...basicQuery(query) }),
          ),
        ),
    )
    .get(
      '/v1/collections/:collectionId',
      {
        query: t.Object(viewQuery, closed),
        params: collectionParams,
        response: { 200: t.Object({ collection: embedded(collectionSchema, curatorFields) }, closed), ...failures },
        detail: detail('collection.get', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          fullView(viewDependencies(), actor, query.view, {
            collection: await read().readCollection(actor, params.collectionId),
          }),
        ),
    )
    .patch(
      '/v1/collections/:collectionId',
      {
        params: collectionParams,
        headers,
        body: strict(
          t.Object(
            {
              revision,
              title: t.Optional(t.String()),
              description: t.Optional(nullableString),
              visibility: t.Optional(visibility),
            },
            closed,
          ),
        ),
        response: { 200: collectionResponse, ...failures },
        detail: detail('collection.update', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().updateCollection(actor, params.collectionId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { collection: collectionView(result.value) };
      },
    )
    .delete(
      '/v1/collections/:collectionId',
      {
        params: collectionParams,
        headers,
        query: t.Object(
          { revision: t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }) },
          closed,
        ),
        response: { 204: t.Void(), ...failures },
        detail: detail('collection.delete', 'collection:delete'),
      },
      async ({ params, query, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().deleteCollection(actor, params.collectionId, query.revision, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 204;
      },
    )
    .get(
      '/v1/collections/:collectionId/members',
      {
        params: collectionParams,
        query: t.Object(pageQuery, closed),
        response: {
          200: t.Object({ members: t.Array(embedded(memberSchema, subjectFields)), next: nullableString }, closed),
          ...failures,
        },
        detail: detail('collection_member.list', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, () =>
          query.view === 'FULL'
            ? fullMembers(viewDependencies(), actor, params.collectionId, basicQuery(query))
            : read().listMembers(actor, params.collectionId, basicQuery(query)),
        ),
    )
    .post(
      '/v1/collections/:collectionId/members',
      {
        params: collectionParams,
        headers,
        body: strict(
          t.Object({ subjectId: id, note: t.Optional(nullableString), after: t.Optional(nullableString) }, closed),
        ),
        response: { 201: memberResponse, ...failures },
        detail: detail('collection_member.create', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().addMember(actor, params.collectionId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return { member: memberView(result.value) };
      },
    )
    .patch(
      '/v1/collections/:collectionId/members/:memberId',
      {
        params: memberParams,
        headers,
        body: strict(t.Object({ note: nullableString }, closed)),
        response: { 200: memberResponse, ...failures },
        detail: detail('collection_member.update', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().updateMemberNote(actor, params.collectionId, params.memberId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { member: memberView(result.value) };
      },
    )
    .delete(
      '/v1/collections/:collectionId/members/:memberId',
      {
        params: memberParams,
        headers,
        response: { 204: t.Void(), ...failures },
        detail: detail('collection_member.delete', 'collection:update'),
      },
      async ({ params, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().removeMember(actor, params.collectionId, params.memberId, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 204;
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members/:memberId', 'move'),
      {
        params: memberParams,
        headers,
        body: strict(t.Object({ after: nullableString }, closed)),
        response: { 200: memberResponse, ...failures },
        detail: detail('collection_member.move', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().moveMember(actor, params.collectionId, params.memberId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { member: memberView(result.value) };
      },
    )
    .get(
      '/v1/subjects/:id/collections',
      {
        params: t.Object({ id }, closed),
        query: t.Object(pageQuery, closed),
        response: { 200: fullSubjectPage, ...failures },
        detail: detail('subject_collection.list', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          fullView(
            viewDependencies(),
            actor,
            query.view,
            await read().listSubjectCollections(actor, params.id, basicQuery(query)),
          ),
        ),
    );
}
