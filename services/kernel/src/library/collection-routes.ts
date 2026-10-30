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
import { FactSchema } from '../search/http/routes.ts';
import { CoverSummarySchema } from '../semantic/http/summaries.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Collection, CollectionMember } from './collection-model.ts';
import { createCollectionReads } from './collection-reads.ts';
import { createCollectionCommands } from './collections.ts';
import { collectionPresentation } from './collection-presentation.ts';
import { parseCollectionRule, requireCollectionRuleExecution } from './collection-rules.ts';
import { listSitemapCollections } from './sitemap.ts';

import { basicQuery, curatorFields, embedded, fullMembers, fullView, subjectFields, viewQuery } from './views.ts';

type Dependencies = { pool: Pool; access: () => Access; tokens: KeyRing; clock: KernelClock; routeKey: Uint8Array };
const closed = { additionalProperties: false } as const;
// Domain commands and reads distinguish malformed resource IDs from malformed JSON.
const id = t.String();
const nullableString = t.Union([t.String(), t.Null()]);
const visibility = t.Union([t.Literal('private'), t.Literal('unlisted'), t.Literal('public')]);
const revision = t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const collectionSchema = t.Object(
  {
    id,
    membershipKind: t.Literal('curated'),
    curatorAccountId: t.Union([id, t.Null()]),
    title: t.String(),
    description: nullableString,
    visibility,
    presentationKind: nullableString,
    presentationKindSource: t.Union([
      t.Literal('owner'),
      t.Literal('members'),
      t.Literal('empty'),
      t.Literal('pending'),
    ]),
    cover: t.Optional(CoverSummarySchema),
    coverSource: t.Union([t.Literal('owner'), t.Literal('member'), t.Literal('none'), t.Literal('pending')]),
    coverMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
    revision,
    memberCount: t.Integer(),
    orderEpoch: t.Integer({ minimum: 0 }),
    createdAt: t.String(),
    updatedAt: t.String(),
  },
  closed,
);
const dynamicCollectionSchema = t.Object(
  {
    id,
    curatorAccountId: id,
    membershipKind: t.Literal('dynamic'),
    builtinKind: t.Union([t.Literal('everything'), t.Literal('state')]),
    builtin: t.Union([
      t.Object({ kind: t.Literal('everything') }, closed),
      t.Object({ kind: t.Literal('state'), profileId: id, stateSetId: id, stateId: id }, closed),
    ]),
    builtinLabels: t.Optional(t.Record(t.String(), t.String())),
    title: nullableString,
    description: nullableString,
    visibility: t.Literal('private'),
    revision: t.Integer({ minimum: 0 }),
    presentationKind: t.Null(),
    presentationKindSource: t.Literal('empty'),
    cover: t.Null(),
    coverSource: t.Literal('none'),
  },
  closed,
);
export const collectionReadSchema = t.Union([
  embedded(collectionSchema, curatorFields),
  embedded(dynamicCollectionSchema, curatorFields),
]);
const memberIds = t.Array(t.String(), { minItems: 1, maxItems: 100, uniqueItems: true });
const memberSchema = t.Object({ id, subjectId: id, note: nullableString, addedAt: t.String() }, closed);
const {
  memberCount: _count,
  createdAt: _created,
  updatedAt: _updated,
  ...dynamicMetadata
} = collectionSchema.properties;
export const savedDynamicCollectionSchema = t.Object(
  { ...dynamicMetadata, membershipKind: t.Literal('dynamic') },
  closed,
);
export const collectionResourceSchema = t.Union([collectionSchema, savedDynamicCollectionSchema, dynamicCollectionSchema]);
const embeddedCollectionSchema = t.Union([
  embedded(collectionSchema, curatorFields),
  embedded(savedDynamicCollectionSchema, curatorFields),
  embedded(dynamicCollectionSchema, curatorFields),
]);
const collectionResponse = t.Object({ collection: collectionResourceSchema }, closed);
const createMetadata = {
  title: t.String(),
  description: t.Optional(nullableString),
  visibility,
  presentationKind: t.Optional(nullableString),
  coverMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
};
const ruleBody = { filter: t.Unknown(), sort: t.Optional(t.String()) };
const memberResponse = t.Object({ member: memberSchema }, closed);
const subjectPage = t.Object(
  {
    collections: t.Array(
      t.Object(
        {
          id,
          curatorAccountId: t.Union([id, t.Null()]),
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
  409: problemSchema('conflict', 'collection_full', 'stale_cursor', 'dynamic_membership_immutable'),
  422: problemSchema('idempotency_conflict', 'unsupported_query'),
  503: problemSchema(
    'semantic_not_ready',
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};
const batchFailures = {
  ...failures,
  409: problemSchema('conflict', 'collection_full', 'stale_cursor', 'dynamic_membership_immutable'),
};
const memberRestoreFailures = {
  ...failures,
  409: problemSchema(
    'conflict',
    'collection_full',
    'member_restore_stale',
    'member_restore_occupied',
    'member_restore_expired',
  ),
};
const writeRate = defineRateLimit({ family: 'write', units: 1 });
function detail(operationId: string, action: string, anonymous = false) {
  return {
    operationId,
    'x-exposure': 'gate:collections',
    'x-action': action,
    ...(operationId.startsWith('collection_member.')
      ? { 'x-authority-resource-types': ['library.collection'] }
      : { 'x-resource-types': ['library.collection'] }),
    security: anonymous ? [{ bearerAuth: [] }, {}] : [{ bearerAuth: [] }],
    ...(anonymous ? {} : { 'x-rate-limit': writeRate }),
  };
}

/** Validate original JSON without Elysia's removal of undeclared body properties. */
export function strict<S extends TSchema>(schema: S) {
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
  const { id, curatorAccountId, title, description, visibility, revision, memberCount, orderEpoch, createdAt, updatedAt } = value;
  if (value.membershipKind === 'dynamic')
    return {
      id,
      curatorAccountId,
      title,
      description,
      visibility,
      revision,
      membershipKind: 'dynamic' as const,
      ...collectionPresentation(value),
    };
  return {
    id,
    curatorAccountId,
    title,
    description,
    visibility,
    membershipKind: 'curated' as const,
    revision,
    memberCount,
    orderEpoch,
    createdAt,
    updatedAt,
    ...collectionPresentation(value),
  };
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
  const write = () =>
    (commands ??= createCollectionCommands({
      pool,
      access: dependencies.access(),
      clock,
      routeKey: dependencies.routeKey,
    }));
  const read = () =>
    (reads ??= createCollectionReads({
      pool,
      access: dependencies.access(),
      tokens,
      clock,
      routeKey: dependencies.routeKey,
    }));
  async function written(value: Collection, actor: Actor) {
    // Receipt values retain their native revision. Only the current viewer's readable descriptor is added.
    if (value.coverMediaId == null) return collectionView(value);
    // Native writes do not require collection:read. Preserve their receipt metadata;
    // descriptor enrichment requires the viewer's independent current read authority.
    if (actor.kind !== 'account' || !actor.scopes.includes('collection:read'))
      return { ...collectionView(value), coverMediaId: value.coverMediaId };
    const current = await read().readCollection(actor, value.id);
    const cover =
      current.membershipKind === 'curated' &&
      current.revision === value.revision &&
      current.coverMediaId === value.coverMediaId
        ? current.cover
        : null;
    return { ...collectionView(value), ...collectionPresentation(value, cover), coverMediaId: value.coverMediaId };
  }
  async function writtenCurated(value: Collection, actor: Actor) {
    const view = await written(value, actor);
    if (!('memberCount' in view)) throw new ProblemError('dynamic_membership_immutable');
    return view;
  }
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
          'x-resource-types': ['library.collection'],
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
        body: strict(
          t.Union([
            t.Object(createMetadata, closed),
            t.Object(
              { ...createMetadata, membershipKind: t.Literal('dynamic'), rule: t.Object(ruleBody, closed) },
              closed,
            ),
          ]),
        ),
        response: { 201: collectionResponse, ...failures },
        detail: { ...detail('collection.create', 'collection:create'), 'x-resource-types': ['library.collection'] },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(
            () =>
              write().createCollection(
                actor,
                'membershipKind' in body ? body : { ...body, membershipKind: 'curated' },
                key,
              ),
            'forbidden',
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return { collection: await written(result.value, actor) };
      },
    )
    .get(
      '/v1/collections',
      {
        query: t.Object({ curatorAccountId: t.Union([id, t.Null()]), ...pageQuery }, closed),
        response: {
          200: t.Object({ collections: t.Array(embeddedCollectionSchema), next: nullableString }, closed),
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
          200: t.Object({ collections: t.Array(embeddedCollectionSchema), next: nullableString }, closed),
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
        response: { 200: t.Object({ collection: embeddedCollectionSchema }, closed), ...failures },
        detail: detail('collection.get', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          fullView(viewDependencies(), actor, query.view, {
            collection: await read().readCollection(actor, params.collectionId),
          }),
        ),
    )
    .put(
      '/v1/collections/:collectionId/rule',
      {
        params: collectionParams,
        headers,
        body: strict(
          t.Object({ revision: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), ...ruleBody }, closed),
        ),
        response: { 200: collectionResponse, ...batchFailures },
        detail: detail('collection_rule.update', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().updateCollectionRule(actor, params.collectionId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { collection: await written(result.value, actor) };
      },
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
              presentationKind: t.Optional(nullableString),
              coverMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
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
        return { collection: await written(result.value, actor) };
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
        query: t.Object({ ...pageQuery, filter: t.Optional(t.String()), sort: t.Optional(t.String()) }, closed),
        response: {
          200: t.Object(
            {
              members: t.Array(
                t.Union([
                  embedded(memberSchema, {
                    ...subjectFields,
                    facts: t.Optional(t.Record(t.String(), t.Array(FactSchema, { maxItems: 3 }), { maxProperties: 4 })),
                  }),
                  t.Object({ kind: t.Literal('dynamic'), subjectId: id, ...subjectFields }, closed),
                ]),
              ),
              next: nullableString,
            },
            closed,
          ),
          ...failures,
          422: problemSchema('unsupported_query'),
        },
        detail: detail('collection_member.list', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        if (query.filter !== undefined || query.sort !== undefined) {
          let filter: unknown;
          try {
            filter = query.filter === undefined ? undefined : JSON.parse(query.filter);
          } catch {
            throw new ProblemError('invalid_request');
          }
          if (filter === undefined) throw new ProblemError('unsupported_query');
          parseCollectionRule({ filter, ...(query.sort === undefined ? {} : { sort: query.sort }) });
          // No common filter/page admission is published yet; never silently run a paging-only request.
          await requireCollectionRuleExecution();
        }
        return admission.run('normal', job, () =>
          query.view === 'FULL'
            ? fullMembers(
                viewDependencies(),
                actor,
                params.collectionId,
                {
                  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                  ...(query.limit === undefined ? {} : { limit: query.limit }),
                },
                job.deadline,
              )
            : read().readMembers(actor, params.collectionId, {
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: query.limit }),
              }),
        );
      },
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
    .post(
      customMethod('/v1/collections/:collectionId/members', 'batchRemove'),
      {
        params: collectionParams,
        headers,
        body: strict(t.Object({ revision, memberIds }, closed)),
        response: {
          200: t.Object(
            {
              collection: collectionSchema,
              removed: t.Array(t.Object({ memberId: id, deletionId: id, revision }, closed)),
            },
            closed,
          ),
          ...batchFailures,
        },
        detail: detail('collection_member.batch_remove', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().batchRemoveMembers(actor, params.collectionId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { collection: await writtenCurated(result.value.collection, actor), removed: result.value.removed };
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members', 'move'),
      {
        params: collectionParams,
        headers,
        body: strict(
          t.Object(
            { revision, memberIds, destinationCollectionId: id, destinationRevision: revision, after: nullableString },
            closed,
          ),
        ),
        response: {
          200: t.Object(
            { source: collectionSchema, destination: collectionSchema, members: t.Array(memberSchema) },
            closed,
          ),
          ...batchFailures,
        },
        detail: detail('collection_member.transfer', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().transferMembers(actor, params.collectionId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return {
          source: await writtenCurated(result.value.source, actor),
          destination: await writtenCurated(result.value.destination, actor),
          members: result.value.members.map(memberView),
        };
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
        query: t.Object({ revision }, closed),
        response: { 204: t.Void(), ...failures },
        detail: detail('collection_member.delete', 'collection:update'),
      },
      async ({ params, query, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().removeMember(actor, params.collectionId, params.memberId, query.revision, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.headers['Library-Collection-Member-Deletion-Id'] = result.value.deletionId;
        set.headers['Library-Collection-Member-Deletion-Revision'] = String(result.value.revision);
        set.status = 204;
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members/:memberId', 'restore'),
      {
        params: memberParams,
        headers,
        body: strict(t.Object({ deletionId: id, revision }, closed)),
        response: { 200: memberResponse, ...memberRestoreFailures },
        detail: detail('collection_member.restore', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().restoreMember(actor, params.collectionId, params.memberId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { member: memberView(result.value) };
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
