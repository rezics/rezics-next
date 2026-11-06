import { memoizedValue } from '../memoized.ts';
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
import { IDEMPOTENCY_HEADER } from '../http/headers.ts';
import { idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { languageRanges } from '../semantic/language.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { FactSchema } from '../search/http/routes.ts';
import { CoverSummarySchema, SubjectSummarySchema } from '../semantic/http/summaries.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { SearchService } from '../search/service-scope.ts';
import type { Collection, CollectionMember } from './collection-model.ts';
import { collectionReadView, createCollectionReads } from './collection-reads.ts';
import { viewerPersonalActionsResponseSchema } from './viewer-personal-actions-schema.ts';
import type { ViewerPersonalActionsReader } from './viewer-personal-actions.ts';
import { createCollectionPublicationEpisodes } from './collection-publication-episodes.ts';
import { createCollectionCommands } from './collections.ts';
import { createCollectionStructureHistory } from './collection-structure-history.ts';
import { createCollectionPublications } from './collection-publication.ts';
import { createCollectionPublicationService } from './collection-publication-service.ts';
import {
  collectionPublicationStatusSchema,
  collectionPublishQueryRequestSchema,
} from './collection-publication-http.ts';
import { collectionPresentation } from './collection-presentation.ts';
import { collectionBulkRoutes } from './collection-bulk-routes.ts';
import { listSitemapCollections } from './sitemap.ts';

import { basicQuery, curatorFields, embedded, fullMembers, fullView, subjectFields, viewQuery } from './views.ts';
import { assertMemberPageCurrent } from './member-viewer-currentness.ts';
import { withCollectionRetentionDeclaration } from './collection-retention-bounds.ts';

type Dependencies = {
  pool: Pool;
  access: () => Access;
  tokens: KeyRing;
  clock: KernelClock;
  routeKey: Uint8Array;
  search?: SearchService;
  workClient?: () => Promise<WorkClient>;
  viewerPersonalActions?: ViewerPersonalActionsReader;
};
const closed = { additionalProperties: false } as const;
// Domain commands and reads distinguish malformed resource IDs from malformed JSON.
const id = t.String();
const nullableString = t.Union([t.String(), t.Null()]);
const visibility = t.Union([t.Literal('private'), t.Literal('unlisted'), t.Literal('public')]);
const revision = t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export function collectionSchema() {
  return memoizedValue(collectionSchema, () =>
    t.Object(
      {
        id,
        membershipKind: t.Literal('curated'),
        curatorAccountId: t.Union([id, t.Null()]),
        title: t.String(),
        description: nullableString,
        visibility,
        allowedVisibilityActions: t.Optional(t.Array(visibility, { uniqueItems: true })),
        presentationKind: nullableString,
        presentationKindSource: t.Union([t.Literal('owner'), t.Literal('mixed')]),
        cover: t.Optional(t.Union([CoverSummarySchema, t.Null()])),
        coverSource: t.Union([t.Literal('owner'), t.Literal('member'), t.Literal('none'), t.Literal('pending')]),
        coverMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        revision,
        memberCount: t.Integer(),
        orderEpoch: t.Integer({ minimum: 0 }),
        createdAt: t.String(),
        updatedAt: t.String(),
      },
      closed,
    ),
  );
}
function dynamicCollectionSchema() {
  return memoizedValue(dynamicCollectionSchema, () =>
    t.Object(
      {
        id,
        curatorAccountId: id,
        membershipKind: t.Literal('dynamic'),
        builtinKind: t.Union([t.Literal('everything'), t.Literal('state'), t.Literal('liked')]),
        builtin: t.Union([
          t.Object({ kind: t.Literal('everything') }, closed),
          t.Object({ kind: t.Literal('liked') }, closed),
          t.Object(
            {
              kind: t.Literal('state'),
              profileId: t.String(),
              stateSetId: t.String(),
              stateId: t.String(),
            },
            closed,
          ),
        ]),
        builtinLabels: t.Optional(t.Record(t.String(), t.String())),
        title: nullableString,
        description: nullableString,
        visibility: t.Literal('private'),
        allowedVisibilityActions: t.Optional(t.Array(visibility, { uniqueItems: true })),
        revision: t.Integer({ minimum: 0 }),
        presentationKind: collectionSchema().properties.presentationKind,
        presentationKindSource: collectionSchema().properties.presentationKindSource,
        cover: t.Null(),
        coverSource: t.Literal('none'),
      },
      closed,
    ),
  );
}
export function collectionReadSchema() {
  return memoizedValue(collectionReadSchema, () =>
    t.Union([embedded(collectionSchema(), curatorFields), embedded(dynamicCollectionSchema(), curatorFields)]),
  );
}
const memberIds = t.Array(t.String(), {
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
});
const memberSchema = t.Object({ id, subjectId: id, note: nullableString, addedAt: t.String() }, closed);
function previewFields() {
  return memoizedValue(previewFields, () => ({
    previewMembers: t.Optional(
      t.Array(t.Object({ subjectId: id, subject: SubjectSummarySchema }, closed), { maxItems: 3 }),
    ),
    previewStatus: t.Optional(t.Union([t.Literal('ready'), t.Literal('pending')])),
  }));
}
function dynamicMetadata() {
  return memoizedValue(dynamicMetadata, () =>
    (() => {
      const {
        memberCount: _count,
        orderEpoch: _order,
        createdAt: _created,
        updatedAt: _updated,
        ...metadata
      } = collectionSchema().properties;
      return metadata;
    })(),
  );
}
export function savedDynamicCollectionSchema() {
  return memoizedValue(savedDynamicCollectionSchema, () =>
    t.Object({ ...dynamicMetadata(), membershipKind: t.Literal('dynamic') }, closed),
  );
}
export const collectionPublicationSchema = t.Object(
  {
    generation: t.String({ format: 'uuid' }),
    state: t.Literal('complete'),
    itemCount: t.Integer({ minimum: 0, maximum: 100 }),
  },
  closed,
);
export const collectionPublicationRequestSchema = t.Object(
  { revision, subjectIds: t.Array(t.String({ format: 'uuid' }), { maxItems: 100, uniqueItems: true }) },
  closed,
);
export function collectionResourceSchema() {
  return memoizedValue(collectionResourceSchema, () =>
    t.Union([collectionSchema(), savedDynamicCollectionSchema(), dynamicCollectionSchema()]),
  );
}
function embeddedCollectionSchema() {
  return memoizedValue(embeddedCollectionSchema, () =>
    t.Union([
      embedded(collectionSchema(), curatorFields),
      embedded(savedDynamicCollectionSchema(), curatorFields),
      embedded(dynamicCollectionSchema(), curatorFields),
    ]),
  );
}
function previewCollectionSchema() {
  return memoizedValue(previewCollectionSchema, () =>
    t.Union([
      embedded(collectionSchema(), { ...curatorFields, ...previewFields() }),
      embedded(savedDynamicCollectionSchema(), {
        ...curatorFields,
        ...previewFields(),
      }),
      embedded(dynamicCollectionSchema(), { ...curatorFields, ...previewFields() }),
    ]),
  );
}
function collectionResponse() {
  return memoizedValue(collectionResponse, () => t.Object({ collection: collectionResourceSchema() }, closed));
}
const metadataHistoryField = t.Union([
  t.Literal('title'),
  t.Literal('description'),
  t.Literal('visibility'),
  t.Literal('presentationKind'),
  t.Literal('coverMediaId'),
]);
const metadataHistoryBasis = t.Object(
  {
    collectionRevision: revision,
    curatorAccountId: id,
    viewerAccountId: id,
    authnEpoch: t.Integer({ minimum: 1 }),
    minimumAuthnEpoch: t.String(),
  },
  closed,
);
const metadataHistoryCoverage = t.Object(
  {
    coverage: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')]),
    knownFromRevision: t.Union([revision, t.Null()]),
    prunedBeforeRevision: t.Union([revision, t.Null()]),
  },
  closed,
);
const metadataHistoryActions = t.Object({ review: t.Literal(true), reapply: t.Literal(false) }, closed);
const metadataHistoryPageResponse = t.Object(
  {
    collectionId: id,
    basis: metadataHistoryBasis,
    coverage: metadataHistoryCoverage,
    items: t.Array(
      t.Object(
        {
          revision,
          recordedAt: t.String(),
          changedFields: t.Array(metadataHistoryField, { minItems: 1, maxItems: 5 }),
        },
        closed,
      ),
      { maxItems: 50 },
    ),
    next: nullableString,
    actions: metadataHistoryActions,
  },
  closed,
);
function historicalCover() {
  return memoizedValue(historicalCover, () =>
    t.Union([
      t.Object({ state: t.Literal('none') }, closed),
      t.Object({ state: t.Literal('unavailable') }, closed),
      t.Object({ state: t.Literal('available'), mediaId: id, summary: CoverSummarySchema }, closed),
    ]),
  );
}
function historicalSnapshot() {
  return memoizedValue(historicalSnapshot, () =>
    t.Object(
      {
        title: t.String(),
        description: nullableString,
        visibility,
        presentationKind: nullableString,
        cover: historicalCover(),
      },
      closed,
    ),
  );
}
function metadataHistoryChangeResponse() {
  return memoizedValue(metadataHistoryChangeResponse, () =>
    t.Object(
      {
        collectionId: id,
        revision,
        recordedAt: t.String(),
        changedFields: t.Array(metadataHistoryField, { minItems: 1, maxItems: 5 }),
        before: historicalSnapshot(),
        after: historicalSnapshot(),
        basis: metadataHistoryBasis,
        actions: metadataHistoryActions,
      },
      closed,
    ),
  );
}
const createMetadata = {
  title: t.String(),
  description: t.Optional(nullableString),
  visibility,
  presentationKind: t.Optional(nullableString),
  coverMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
};
const ruleSource = t.Union([
  t.Object({ kind: t.Literal('owner') }, closed),
  t.Object({ kind: t.Literal('catalogue') }, closed),
]);
const ruleBody = { filter: t.Unknown(), sort: t.Optional(t.String()), source: t.Optional(ruleSource) };
const memberResponse = t.Object({ member: memberSchema }, closed);
const structurePlacementSchema = t.Union([
  t.Object(
    {
      state: t.Literal('known'),
      beforeMemberId: nullableString,
      afterMemberId: nullableString,
    },
    closed,
  ),
  t.Object({ state: t.Literal('unavailable') }, closed),
]);
const structureStateSchema = t.Object(
  {
    presence: t.Union([t.Literal('live'), t.Literal('deleted'), t.Literal('not_in_collection')]),
    memberRevision: t.String(),
    note: nullableString,
    addedAt: nullableString,
    deletedAt: nullableString,
    placement: structurePlacementSchema,
  },
  closed,
);
const structureChangeSchema = t.Object(
  {
    address: t.String({ maxLength: 4096 }),
    operation: t.Union([
      t.Literal('added'),
      t.Literal('note_changed'),
      t.Literal('moved'),
      t.Literal('deleted'),
      t.Literal('restored'),
      t.Literal('transferred_in'),
      t.Literal('transferred_out'),
    ]),
    recordedAt: t.String(),
    occurrenceId: id,
    memberRevision: t.String(),
    before: t.Union([structureStateSchema, t.Null()]),
    after: t.Union([structureStateSchema, t.Null()]),
    subjectContext: t.Object({ state: t.Literal('withheld') }, closed),
  },
  closed,
);
const structureCoverageSchema = t.Object(
  {
    retainedChanges: t.Integer({ minimum: 0, maximum: 1000 }),
    firstRetainedChangeNo: nullableString,
    latestRecordedChangeNo: nullableString,
    hasPrunedGaps: t.Boolean(),
    historyBeforeTracking: t.Union([
      t.Literal('unknown_before_installation'),
      t.Literal('collection_created_after_installation'),
    ]),
  },
  closed,
);
const structureBasisSchema = t.Object(
  {
    throughChangeNo: t.String(),
    hadUnknownPrehistory: t.Boolean(),
    hadPrunedGaps: t.Boolean(),
  },
  closed,
);
const structureHistoryPageSchema = t.Object(
  {
    collectionId: id,
    changes: t.Array(structureChangeSchema, { maxItems: 50 }),
    next: nullableString,
    coverage: structureCoverageSchema,
    basis: structureBasisSchema,
  },
  closed,
);
const structureHistoryComparisonSchema = t.Object(
  {
    status: t.Union([t.Literal('ready'), t.Literal('retired')]),
    changes: t.Array(structureChangeSchema, { maxItems: 2 }),
    coverage: structureCoverageSchema,
    basis: t.Union([structureBasisSchema, t.Null()]),
  },
  closed,
);
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
function fullSubjectPage() {
  return memoizedValue(fullSubjectPage, () =>
    t.Object(
      {
        ...subjectPage.properties,
        collections: t.Array(embedded(subjectPage.properties.collections.items, curatorFields)),
      },
      closed,
    ),
  );
}
const collectionParams = t.Object({ collectionId: id }, closed);
const collectionPublicationParams = t.Object({ id: t.String({ format: 'uuid' }) }, closed);
const memberParams = t.Object({ collectionId: id, memberId: id }, closed);
function headers() {
  return memoizedValue(headers, () =>
    t.Object({
      [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }),
    }),
  );
}
function pageQuery() {
  return memoizedValue(pageQuery, () => ({
    ...viewQuery,
    cursor: t.Optional(t.String({ maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
  }));
}
function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden'),
    404: problemSchema('not_found'),
    409: problemSchema(
      'conflict',
      'collection_full',
      'stale_cursor',
      'dynamic_membership_immutable',
      'collection_move_unsupported',
    ),
    422: problemSchema('idempotency_conflict', 'unsupported_query'),
    503: problemSchema(
      'semantic_not_ready',
      'dependency_unavailable',
      'overloaded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'deadline_exceeded',
    ),
  }));
}
function batchFailures() {
  return memoizedValue(batchFailures, () => ({
    ...failures(),
    409: problemSchema(
      'conflict',
      'collection_full',
      'stale_cursor',
      'dynamic_membership_immutable',
      'collection_move_unsupported',
    ),
  }));
}
function memberRestoreFailures() {
  return memoizedValue(memberRestoreFailures, () => ({
    ...failures(),
    409: problemSchema(
      'conflict',
      'collection_full',
      'member_restore_stale',
      'member_restore_occupied',
      'member_restore_expired',
    ),
  }));
}
function writeRate() {
  return memoizedValue(writeRate, () => defineRateLimit({ family: 'write', units: 1 }));
}
function detail(operationId: string, action: string, anonymous = false) {
  return {
    operationId,
    'x-exposure': 'gate:collections',
    'x-action': action,
    ...(operationId.startsWith('collection_member.')
      ? { 'x-authority-resource-types': ['library.collection'] }
      : { 'x-resource-types': ['library.collection'] }),
    security: anonymous ? [{ bearerAuth: [] }, {}] : [{ bearerAuth: [] }],
    ...(anonymous ? {} : { 'x-rate-limit': writeRate() }),
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
          : {
              issues: [{ message: 'Value does not match the Collection schema' }],
            };
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
  const {
    id,
    curatorAccountId,
    title,
    description,
    visibility,
    revision,
    memberCount,
    orderEpoch,
    createdAt,
    updatedAt,
  } = value;
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
  let structureHistory: ReturnType<typeof createCollectionStructureHistory> | undefined;
  let publications: ReturnType<typeof createCollectionPublications> | undefined;
  let wholeQueryPublications: ReturnType<typeof createCollectionPublicationService> | undefined;
  const wholeQuery = () =>
    (wholeQueryPublications ??= createCollectionPublicationService({
      pool,
      access: dependencies.access(),
      clock,
    }));
  const publish = () =>
    (publications ??= createCollectionPublications({
      pool,
      access: dependencies.access(),
      tokens,
      clock,
    }));
  const viewDependencies = () => ({
    ...dependencies,
    access: dependencies.access(),
  });
  const write = () =>
    (commands ??= createCollectionCommands({
      pool,
      access: dependencies.access(),
      clock,
      routeKey: dependencies.routeKey,
      publication: createCollectionPublicationEpisodes({ pool, access: dependencies.access(), clock }),
    }));
  const read = () =>
    (reads ??= createCollectionReads({
      pool,
      access: dependencies.access(),
      tokens,
      clock,
      ...(dependencies.viewerPersonalActions ? { viewerPersonalActions: dependencies.viewerPersonalActions } : {}),
      routeKey: dependencies.routeKey,
      ...(dependencies.workClient ? { workClient: dependencies.workClient } : {}),
      ...(dependencies.search ? { search: dependencies.search } : {}),
    }));
  const history = () =>
    (structureHistory ??= createCollectionStructureHistory({
      pool,
      tokens,
      current: (actor, collectionId, deadline) => read().readCollection(actor, collectionId, deadline),
    }));
  async function written(value: Collection, actor: Actor, includeOwnerManagement = false) {
    // Receipt values retain their native revision. Only the current viewer's readable descriptor is added.
    const hasCover = value.coverMediaId != null;
    const ownerManagement =
      includeOwnerManagement &&
      actor.kind === 'account' &&
      actor.accountId === value.curatorAccountId &&
      actor.scopes.includes('collection:read');
    if (!hasCover && !ownerManagement) return collectionView(value);
    // Native writes do not require collection:read. Preserve their receipt metadata;
    // descriptor enrichment requires the viewer's independent current read authority.
    if (includeOwnerManagement && !ownerManagement) throw new ProblemError('not_found');
    if (actor.kind !== 'account' || !actor.scopes.includes('collection:read'))
      return { ...collectionView(value), coverMediaId: value.coverMediaId };
    const current = await read().readCollection(actor, value.id, undefined, undefined, ownerManagement);
    if (ownerManagement && (current.revision !== value.revision || current.visibility !== value.visibility))
      throw new ProblemError('dependency_unavailable');
    const cover =
      hasCover &&
      'coverMediaId' in current &&
      current.revision === value.revision &&
      current.coverMediaId === value.coverMediaId
        ? current.cover
        : null;
    return {
      ...collectionView(value),
      ...(ownerManagement && 'allowedVisibilityActions' in current
        ? { allowedVisibilityActions: current.allowedVisibilityActions }
        : {}),
      ...(hasCover ? { ...collectionPresentation(value, cover), coverMediaId: value.coverMediaId } : {}),
    };
  }
  async function writtenCurated(value: Collection, actor: Actor) {
    const view = await written(value, actor);
    if (!('memberCount' in view)) throw new ProblemError('dynamic_membership_immutable');
    return view;
  }
  const sitemapQuery = strict(SitemapQuerySchema);
  return collectionBulkRoutes(app, {
    ...dependencies,
    reads: {
      readCollection: (actor, id, deadline) => read().readCollection(actor, id, deadline),
      readMembers: (actor, id, options, deadline) => read().readMembers(actor, id, options, deadline),
    },
  })
    .post(
      customMethod('/v1/collections/:collectionId', 'publish'),
      {
        params: collectionParams,
        headers: headers(),
        body: strict(collectionPublishQueryRequestSchema),
        response: {
          200: strict(collectionPublicationStatusSchema),
          202: strict(collectionPublicationStatusSchema),
          ...failures(),
        },
        detail: detail('collection.publish_query', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() =>
            wholeQuery().begin(
              actor,
              {
                collectionId: params.collectionId,
                revision: body.revision,
                visibility: body.visibility,
              },
              key,
            ),
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        const status = await wholeQuery().status(actor, result.value.locator.publicationId);
        set.status = status.phase === 'staging' || status.phase === 'awaiting_activation' ? 202 : 200;
        return status;
      },
    )
    .get(
      '/v1/collectionPublications/:id',
      {
        params: collectionPublicationParams,
        response: { 200: strict(collectionPublicationStatusSchema), ...failures() },
        detail: detail('collection_publication.get', 'collection:update'),
      },
      async ({ params, actor, admission, job, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => wholeQuery().status(actor, params.id));
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId', 'publishSelected'),
      {
        params: collectionParams,
        headers: headers(),
        body: strict(collectionPublicationRequestSchema),
        response: {
          200: t.Object(
            { collection: savedDynamicCollectionSchema(), publication: collectionPublicationSchema },
            closed,
          ),
          ...failures(),
        },
        detail: detail('collection.publish_selected', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => publish().publishSelected(actor, params.collectionId, body, key)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        const collection = await written(result.value.collection, actor);
        if (collection.membershipKind !== 'dynamic') throw new ProblemError('dependency_unavailable');
        return { collection, publication: result.value.publication };
      },
    )
    .get(
      '/v1/sitemap/collections',
      {
        query: SitemapQuerySchema,
        transform: ({ query }) => {
          if ('issues' in sitemapQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: strict(SitemapBoardPageSchema), ...failures() },
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
        headers: headers(),
        body: strict(
          t.Union([
            t.Object(createMetadata, closed),
            t.Object(
              {
                ...createMetadata,
                membershipKind: t.Literal('dynamic'),
                rule: t.Object(ruleBody, closed),
              },
              closed,
            ),
          ]),
        ),
        response: { 201: collectionResponse(), ...failures() },
        detail: {
          ...detail('collection.create', 'collection:create'),
          'x-resource-types': ['library.collection'],
        },
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
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        set.status = 201;
        return { collection: await written(result.value, actor) };
      },
    )
    .get(
      '/v1/collections',
      {
        query: t.Object(
          {
            curatorAccountId: t.Union([id, t.Null()]),
            ...pageQuery(),
            ownerManagement: t.Optional(t.Boolean()),
            preview: t.Optional(t.Numeric({ minimum: 3, maximum: 3, multipleOf: 1 })),
          },
          closed,
        ),
        response: {
          200: t.Object(
            {
              collections: t.Array(previewCollectionSchema()),
              next: nullableString,
              ownerManagement: t.Optional(t.Literal('owner')),
              ownerAccountId: t.Optional(id),
            },
            closed,
          ),
          ...failures(),
        },
        detail: detail('collection.list', 'collection:read', true),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ query, actor, admission, job }) =>
        admission.run('normal', job, async () => {
          const { preview, ...options } = query;
          if (preview !== undefined && (query.view !== 'FULL' || (query.limit ?? 20) > 20))
            throw new ProblemError('invalid_request');
          return read().listCollections(
            actor,
            {
              ...basicQuery(options),
              ...(query.ownerManagement === undefined ? {} : { ownerManagement: query.ownerManagement }),
            },
            preview === undefined ? undefined : { deadline: job.deadline },
            {
              deadline: job.deadline,
              present: (page) =>
                fullView(
                  viewDependencies(),
                  actor,
                  query.view,
                  {
                    ...page,
                    collections: page.collections.map(collectionReadView),
                  },
                  { deadline: job.deadline },
                ),
            },
          );
        }),
    )
    .get(
      '/v1/accounts/:accountId/collections',
      {
        params: t.Object({ accountId: id }, closed),
        query: t.Object(pageQuery(), closed),
        response: {
          200: t.Object(
            {
              collections: t.Array(embeddedCollectionSchema()),
              next: nullableString,
            },
            closed,
          ),
          ...failures(),
        },
        detail: detail('account.collections', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () => {
          return read().listAccountCollections(
            actor,
            {
              curatorAccountId: params.accountId,
              ...basicQuery(query),
            },
            {
              deadline: job.deadline,
              present: (page) =>
                fullView(
                  viewDependencies(),
                  actor,
                  query.view,
                  {
                    ...page,
                    collections: page.collections.map(collectionReadView),
                  },
                  { deadline: job.deadline },
                ),
            },
          );
        }),
    )
    .get(
      '/v1/collections/:collectionId',
      {
        query: t.Object({ ...viewQuery, ownerManagement: t.Optional(t.Boolean()) }, closed),
        params: collectionParams,
        response: {
          200: t.Object({ collection: embeddedCollectionSchema() }, closed),
          ...failures(),
        },
        detail: detail('collection.get', 'collection:read', true),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          fullView(viewDependencies(), actor, query.view, {
            collection: collectionReadView(
              await read().readCollection(
                actor,
                params.collectionId,
                undefined,
                undefined,
                query.ownerManagement === true,
              ),
            ),
          }),
        ),
    )
    .get(
      '/v1/collections/:collectionId/metadata-history',
      {
        params: collectionParams,
        query: t.Object(
          {
            cursor: t.Optional(t.String({ maxLength: 4096 })),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })),
          },
          closed,
        ),
        response: { 200: metadataHistoryPageResponse, ...failures() },
        detail: detail('collection.metadata_history_list', 'collection:update'),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ params, query, actor, admission, job }) => {
        requireAccount(actor);
        return admission.run('normal', job, () =>
          mapped(() => read().readCollectionMetadataHistory(actor, params.collectionId, query, job.deadline)),
        );
      },
    )
    .get(
      '/v1/collections/:collectionId/metadata-history/:revision',
      {
        params: t.Object(
          { collectionId: id, revision: t.Numeric({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }) },
          closed,
        ),
        response: { 200: metadataHistoryChangeResponse(), ...failures() },
        detail: detail('collection.metadata_history_change', 'collection:update'),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ params, actor, admission, job }) => {
        requireAccount(actor);
        return admission.run('normal', job, () =>
          mapped(() =>
            read().readCollectionMetadataHistoryChange(actor, params.collectionId, params.revision, job.deadline),
          ),
        );
      },
    )
    .get(
      '/v1/collections/:collectionId/structure-history',
      {
        params: collectionParams,
        query: t.Object(
          {
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
          },
          closed,
        ),
        response: { 200: strict(structureHistoryPageSchema), ...failures() },
        detail: detail('collection.structure_history_list', 'collection:update'),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ params, query, actor, admission, job }) => {
        requireAccount(actor);
        return admission.run('normal', job, () => history().page(actor, params.collectionId, query, job.deadline));
      },
    )
    .get(
      '/v1/collections/:collectionId/structure-history/compare',
      {
        params: collectionParams,
        query: t.Object(
          { addresses: t.Array(t.String({ maxLength: 4096 }), { minItems: 1, maxItems: 2, uniqueItems: true }) },
          closed,
        ),
        response: { 200: strict(structureHistoryComparisonSchema), ...failures() },
        detail: detail('collection.structure_history_compare', 'collection:update'),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ params, query, actor, admission, job }) => {
        requireAccount(actor);
        return admission.run('normal', job, () =>
          history().compare(actor, params.collectionId, query.addresses, job.deadline),
        );
      },
    )
    .get(
      '/v1/collections/:collectionId/rule',
      {
        params: collectionParams,
        response: {
          200: t.Object(
            {
              rule: t.Object(
                {
                  filter: t.Unknown(),
                  sort: t.Literal('id'),
                  source: ruleSource,
                  releaseDigest: t.String(),
                  revision: t.Integer({ minimum: 0 }),
                  collectionRevision: revision,
                  sourceGeneration: t.String(),
                },
                closed,
              ),
            },
            closed,
          ),
          ...failures(),
        },
        detail: detail('collection_rule.get', 'collection:update'),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
      },
      async ({ params, actor, admission, job }) => {
        requireAccount(actor);
        return admission.run('normal', job, async () => ({
          rule: await mapped(() => read().readRule(actor, params.collectionId, job.deadline)),
        }));
      },
    )
    .put(
      '/v1/collections/:collectionId/rule',
      {
        params: collectionParams,
        headers: headers(),
        body: strict(
          t.Object(
            {
              revision: t.Integer({
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
              }),
              ...ruleBody,
            },
            closed,
          ),
        ),
        response: { 200: collectionResponse(), ...batchFailures() },
        detail: detail('collection_rule.update', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().updateCollectionRule(actor, params.collectionId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return { collection: await written(result.value, actor) };
      },
    )
    .patch(
      '/v1/collections/:collectionId',
      {
        params: collectionParams,
        headers: headers(),
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
        query: t.Object({ ownerManagement: t.Optional(t.Boolean()) }, closed),
        response: { 200: collectionResponse(), ...failures() },
        detail: detail('collection.update', 'collection:update'),
      },
      async ({ params, body, query, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        if (query.ownerManagement === true) set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().updateCollection(actor, params.collectionId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return { collection: await written(result.value, actor, query.ownerManagement === true) };
      },
    )
    .delete(
      '/v1/collections/:collectionId',
      {
        params: collectionParams,
        headers: headers(),
        query: t.Object(
          {
            revision: t.Numeric({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              multipleOf: 1,
            }),
          },
          closed,
        ),
        response: { 204: t.Void(), ...failures() },
        detail: {
          ...detail('collection.delete', 'collection:delete'),
          responses: {
            204: {
              description: 'Collection deleted',
              headers: {
                'Library-Collection-Deletion-Id': {
                  schema: { type: 'string', format: 'uuid' },
                },
                'Library-Collection-Deletion-Revision': {
                  schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
                },
              },
            },
          },
        },
      },
      async ({ params, query, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().deleteCollection(actor, params.collectionId, query.revision, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        withCollectionRetentionDeclaration('deleteResponse', () => {
          set.headers['cache-control'] = 'private, no-store';
          set.headers['Library-Collection-Deletion-Id'] = result.value.deletionId;
          set.headers['Library-Collection-Deletion-Revision'] = String(result.value.revision);
          set.status = 204;
        });
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId', 'restore'),
      {
        params: collectionParams,
        headers: headers(),
        body: strict(t.Object({ deletionId: t.String({ format: 'uuid' }), revision }, closed)),
        response: {
          200: collectionResponse(),
          ...failures(),
          409: problemSchema(
            'conflict',
            'collection_restore_occupied',
            'collection_restore_stale',
            'collection_restore_expired',
          ),
        },
        detail: detail('collection.restore', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        set.headers['cache-control'] = 'private, no-store';
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().restoreCollection(actor, params.collectionId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return withCollectionRetentionDeclaration('restoreResponse', async () => ({
          collection: await written(result.value, actor),
        }));
      },
    )
    .get(
      '/v1/collections/:collectionId/members',
      {
        params: collectionParams,
        query: t.Object(
          {
            ...pageQuery(),
            filter: t.Optional(t.String()),
            sort: t.Optional(t.String()),
          },
          closed,
        ),
        response: {
          200: t.Object(
            {
              members: t.Array(
                t.Union([
                  embedded(memberSchema, {
                    ...subjectFields(),
                    facts: t.Optional(t.Record(t.String(), t.Array(FactSchema, { maxItems: 3 }), { maxProperties: 4 })),
                  }),
                  t.Object(
                    {
                      kind: t.Literal('dynamic'),
                      subjectId: id,
                      ...subjectFields(),
                      facts: t.Optional(
                        t.Record(t.String(), t.Array(FactSchema, { maxItems: 3 }), { maxProperties: 4 }),
                      ),
                    },
                    closed,
                  ),
                ]),
              ),
              next: nullableString,
              viewerFacts: t.Optional(viewerPersonalActionsResponseSchema()),
            },
            closed,
          ),
          ...failures(),
          422: problemSchema('unsupported_query'),
          202: t.Object({ preparing: t.Literal(true) }, closed),
        },
        detail: detail('collection_member.list', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job, set, request }) => {
        set.headers['cache-control'] = 'private, no-store';
        const sourceOptions = query.filter !== undefined || query.sort !== undefined ? query : basicQuery(query);
        const listFactsAttached = query.filter === undefined && query.sort === undefined && query.view === 'FULL';
        const sourcePage = () =>
          admission.run('normal', job, () =>
            read().readMembers(actor, params.collectionId, sourceOptions, job.deadline),
          );
        const finalSource =
          query.view === 'FULL' && actor.kind === 'account'
            ? await read().observeMemberSource(actor, params.collectionId, job.deadline)
            : undefined;
        let result = await admission.run('normal', job, () =>
          query.filter !== undefined || query.sort !== undefined
            ? read().readMembers(actor, params.collectionId, query, job.deadline)
            : query.view === 'FULL'
              ? fullMembers(
                  viewDependencies(),
                  actor,
                  params.collectionId,
                  { ...basicQuery(query), languages: languageRanges(request.headers.get('accept-language')) },
                  job.deadline,
                )
              : read().readMembers(actor, params.collectionId, basicQuery(query), job.deadline),
        );
        if ('members' in result && query.view === 'FULL') {
          const admitted = result;
          result = await read().withViewerFacts(actor, result, job.deadline, async () => {
            assertMemberPageCurrent(admitted, await sourcePage(), { listFactsAttached });
            await finalSource?.();
          });
        }
        if ('preparing' in result) {
          set.status = 202;
          set.headers['retry-after'] = '1';
          return result;
        }
        return { ...result, members: [...result.members] };
      },
    )
    .post(
      '/v1/collections/:collectionId/members',
      {
        params: collectionParams,
        headers: headers(),
        body: strict(
          t.Object(
            {
              subjectId: id,
              note: t.Optional(nullableString),
              after: t.Optional(nullableString),
            },
            closed,
          ),
        ),
        response: { 201: memberResponse, ...failures() },
        detail: detail('collection_member.create', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().addMember(actor, params.collectionId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        set.status = 201;
        return { member: memberView(result.value) };
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members', 'batchRemove'),
      {
        params: collectionParams,
        headers: headers(),
        body: strict(t.Object({ revision, memberIds }, closed)),
        response: {
          200: t.Object(
            {
              collection: collectionSchema(),
              removed: t.Array(t.Object({ memberId: id, deletionId: id, revision }, closed)),
            },
            closed,
          ),
          ...batchFailures(),
        },
        detail: detail('collection_member.batch_remove', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().batchRemoveMembers(actor, params.collectionId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return {
          collection: await writtenCurated(result.value.collection, actor),
          removed: result.value.removed,
        };
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members', 'move'),
      {
        params: collectionParams,
        headers: headers(),
        body: strict(
          t.Object(
            {
              revision,
              memberIds,
              destinationCollectionId: id,
              destinationRevision: revision,
              after: nullableString,
            },
            closed,
          ),
        ),
        response: {
          200: t.Object(
            {
              source: collectionSchema(),
              destination: collectionSchema(),
              members: t.Array(memberSchema),
            },
            closed,
          ),
          ...batchFailures(),
        },
        detail: detail('collection_member.transfer', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().transferMembers(actor, params.collectionId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
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
        headers: headers(),
        body: strict(t.Object({ note: nullableString }, closed)),
        response: { 200: memberResponse, ...failures() },
        detail: detail('collection_member.update', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().updateMemberNote(actor, params.collectionId, params.memberId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return { member: memberView(result.value) };
      },
    )
    .delete(
      '/v1/collections/:collectionId/members/:memberId',
      {
        params: memberParams,
        headers: headers(),
        query: t.Object({ revision }, closed),
        response: { 204: t.Void(), ...failures() },
        detail: detail('collection_member.delete', 'collection:update'),
      },
      async ({ params, query, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().removeMember(actor, params.collectionId, params.memberId, query.revision, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        set.headers['Library-Collection-Member-Deletion-Id'] = result.value.deletionId;
        set.headers['Library-Collection-Member-Deletion-Revision'] = String(result.value.revision);
        set.status = 204;
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members/:memberId', 'restore'),
      {
        params: memberParams,
        headers: headers(),
        body: strict(t.Object({ deletionId: id, revision }, closed)),
        response: { 200: memberResponse, ...memberRestoreFailures() },
        detail: detail('collection_member.restore', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().restoreMember(actor, params.collectionId, params.memberId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return { member: memberView(result.value) };
      },
    )
    .post(
      customMethod('/v1/collections/:collectionId/members/:memberId', 'move'),
      {
        params: memberParams,
        headers: headers(),
        body: strict(t.Object({ after: t.Optional(nullableString) }, closed)),
        response: { 200: memberResponse, ...failures() },
        detail: detail('collection_member.move', 'collection:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => write().moveMember(actor, params.collectionId, params.memberId, body, key)),
        );
        session.record({
          partition: result.partition,
          epoch: result.epoch,
          position: result.position,
        });
        return { member: memberView(result.value) };
      },
    )
    .get(
      '/v1/subjects/:id/collections',
      {
        params: t.Object({ id }, closed),
        query: t.Object(pageQuery(), closed),
        response: { 200: fullSubjectPage(), ...failures() },
        detail: detail('subject_collection.list', 'collection:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, async () =>
          read().listSubjectCollections(actor, params.id, query, {
            deadline: job.deadline,
            present: (page) => fullView(viewDependencies(), actor, query.view, page, { deadline: job.deadline }),
          }),
        ),
    );
}
