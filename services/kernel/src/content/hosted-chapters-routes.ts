import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';
import { memoizedValue } from '../memoized.ts';
import { AuthenticationError } from '../access/contract/authentication.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { customMethod, defineRateLimit } from '../http/route-metadata.ts';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { contentRequestId } from './adapters/bind.ts';
import type { contentRoutes } from './routes.ts';
import { strictContentSchema } from './schema-validation.ts';
import {
  ContentNotFoundError as CommandNotFoundError,
  ContentForbiddenError,
  RevisionPreconditionError,
} from './commands.ts';
import { ContentNotFoundError } from './reads.ts';
import {
  InvalidHostedStructureError,
  InvalidHostedCursorError,
  HostedOwnerInventoryUnavailableError,
} from './hosted-chapters-model.ts';
import {
  createHostedCatalogue,
  reviseHostedCatalogue,
  appendHostedRootChapter,
  insertHostedDraftPoint,
  removeHostedDraftPoint,
  publishHostedCatalogue,
  publishHostedPublicationPoint,
  type HostedCommandDependencies,
} from './hosted-chapters-commands.ts';
import { advanceHostedLegacyPublicBaseline } from './hosted-legacy-public-baseline.ts';
import {
  moveHostedVersionDraftOccurrence,
  type HostedVersionDraftMoveCommandDependencies,
} from './hosted-version-draft-edit-command.ts';
import { createHostedVersionDraftMoveNativeAdapter } from './hosted-version-draft-native.ts';
import { updateHostedDraftPoint } from './hosted-version-draft-update-command.ts';
import {
  readHostedCatalogue,
  listHostedChildren,
  listHostedAuthorOutline,
  navigateHostedChapters,
  resolveHostedOccurrence,
  resolveHostedOccurrenceMetadata,
  hostedPublicationPointSelectionReads,
} from './hosted-chapters-reads.ts';
import { listHostedCatalogueHistory } from './hosted-chapters-history.ts';
import { listOwnHostedCatalogues, readOwnHostedCatalogue } from './hosted-chapters-owner.ts';
import { listHostedCataloguesForSubject } from './hosted-catalogue-subject.ts';
import {
  hostedSubjectCataloguePageSchema,
  hostedSubjectCatalogueQuerySchema,
} from './hosted-catalogue-subject-schemas.ts';
import { hostedPublicationPreparationRoutes } from './hosted-publication-preparation-routes.ts';
import {
  HostedIdSchema,
  HostedCreateSchema,
  HostedReviseSchema,
  HostedRootAppendSchema,
  HostedInsertDraftPointSchema,
  HostedRemoveDraftPointSchema,
  HostedUpdateDraftPointSchema,
  HostedMoveDraftPointSchema,
  HostedPublishSchema,
  HostedPublishChapterSchema,
  HostedReplacePublishedChapterSchema,
  HostedLegacyPublicBaselineSchema,
  HostedLegacyPublicBaselineProgressSchema,
  HostedCommandSchema,
  HostedRevisionSchema,
  HostedHistoryQuerySchema,
  HostedHistoryPageSchema,
  HostedPageSchema,
  HostedResolutionSchema,
  HostedOccurrenceMetadataSchema,
  HostedCatalogueQuerySchema,
  HostedSelectionSchema,
  HostedChildrenQuerySchema,
  HostedOutlineQuerySchema,
  HostedNavigationQuerySchema,
  HostedOwnerInventoryQuerySchema,
  HostedOwnerInventorySchema,
  HostedOwnerInventoryReadSchema,
} from './hosted-chapters-schemas.ts';

function params() {
  return memoizedValue(params, () => t.Object({ id: HostedIdSchema }, { additionalProperties: false }));
}
function occurrenceParams() {
  return memoizedValue(occurrenceParams, () =>
    t.Object({ id: HostedIdSchema, occurrenceId: HostedIdSchema }, { additionalProperties: false }),
  );
}
function ownerParams() {
  return memoizedValue(ownerParams, () => t.Object({ accountId: HostedIdSchema }, { additionalProperties: false }));
}
function ownerReadParams() {
  return memoizedValue(ownerReadParams, () =>
    t.Object({ accountId: HostedIdSchema, id: HostedIdSchema }, { additionalProperties: false }),
  );
}
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const responseHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
    404: problemSchema('not_found'),
    412: problemSchema('precondition_failed'),
    413: problemSchema('content_too_large'),
    422: problemSchema('idempotency_conflict', 'too_many_events'),
    429: problemSchema('rate_limited'),
    500: problemSchema('internal_error'),
    503: problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'dependency_unavailable',
      'rate_limit_unavailable',
    ),
  }));
}
const readSecurity: Record<string, string[]>[] = [{}, { bearerAuth: [] }];
const readDetail = {
  'x-exposure': 'public',
  'x-resource-types': ['content.post'],
  'x-action': 'post:read',
  security: readSecurity,
};
const ownerDetail = { 'x-exposure': 'public', 'x-action': 'account:read', security: [{ bearerAuth: [] }] };
function writeDetail() {
  return memoizedValue(writeDetail, () => ({
    'x-exposure': 'public',
    'x-resource-types': ['content.post'],
    'x-action': 'post:revise',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
    security: [{ bearerAuth: [] }],
  }));
}

async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof CommandNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (error instanceof RevisionPreconditionError) throw new ProblemError('precondition_failed');
    if (error instanceof InvalidHostedCursorError) throw new ProblemError('invalid_cursor');
    if (error instanceof InvalidHostedStructureError) throw new ProblemError('invalid_request');
    if (error instanceof HostedOwnerInventoryUnavailableError)
      throw new ProblemError('dependency_unavailable', { detail: error.message });
    throw error;
  }
}
function commandContext(request: Request, deadline: number) {
  return {
    deadline,
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    requestId: contentRequestId(),
  };
}

/** Mounted once by the ordinary Content HTTP composition; publication and client generation stay in their owners. */
export function hostedChapterRoutes(app: ReturnType<typeof contentRoutes>, deps: HostedCommandDependencies) {
  const moveDependencies = Object.assign(Object.create(deps) as HostedVersionDraftMoveCommandDependencies, {
    versionAdapter: createHostedVersionDraftMoveNativeAdapter(),
  });
  const preparationRoutes = hostedPublicationPreparationRoutes(app, deps);
  preparationRoutes.wrap((handle) => async (request) => {
    const response = await handle(request);
    const path = new URL(request.url).pathname;
    if (
      path.startsWith('/v1/hostedCatalogues') ||
      /^\/v1\/accounts\/[^/]+\/hostedCatalogues(?:\/|$)/.test(path) ||
      /^\/v1\/subjects\/[^/]+\/hostedCatalogues(?:\/|$)/.test(path)
    )
      response.headers.set('cache-control', 'private, no-store');
    return response;
  });
  return preparationRoutes
    .get(
      '/v1/accounts/:accountId/hostedCatalogues',
      {
        params: ownerParams(),
        query: strictContentSchema(HostedOwnerInventoryQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedOwnerInventorySchema), responseHeaders), ...failures() },
        detail: { ...ownerDetail, operationId: 'own_hosted_catalogues.list' },
      },
      async ({ actor, params: { accountId }, query, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const { limit, ...selection } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            listOwnHostedCatalogues(
              deps,
              accountId,
              { actor, deadline: job.deadline },
              { ...selection, ...(limit === undefined ? {} : { limit: Number(limit) }) },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    )
    .get(
      '/v1/accounts/:accountId/hostedCatalogues/:id',
      {
        params: ownerReadParams(),
        query: strictContentSchema(t.Object({}, { additionalProperties: false })),
        response: {
          200: withHeaders(strictContentSchema(HostedOwnerInventoryReadSchema), responseHeaders),
          ...failures(),
        },
        detail: { ...ownerDetail, operationId: 'own_hosted_catalogues.get' },
      },
      async ({ actor, params: { accountId, id }, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            readOwnHostedCatalogue(deps, accountId, id, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      '/v1/hostedCatalogues',
      {
        headers,
        body: strictContentSchema(HostedCreateSchema),
        response: { 201: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.create' },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            createHostedCatalogue(deps, actor, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.status = 201;
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'revise'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedReviseSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.revise' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            reviseHostedCatalogue(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'appendRootChapter'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedRootAppendSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.append_root_chapter' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            appendHostedRootChapter(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'insertDraftPoint'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedInsertDraftPointSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.insert_draft_point' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            insertHostedDraftPoint(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'removeDraftPoint'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedRemoveDraftPointSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.remove_draft_point' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            removeHostedDraftPoint(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'updateDraftPoint'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedUpdateDraftPointSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.update_draft_point' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            updateHostedDraftPoint(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'moveDraftPoint'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedMoveDraftPointSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.move_draft_point' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            moveHostedVersionDraftOccurrence(moveDependencies, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'publishChapter'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedPublishChapterSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.publish_chapter' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = { actor, deadline: job.deadline };
        const result = await operation(() =>
          admission.run('normal', job, () =>
            publishHostedPublicationPoint(
              deps,
              actor,
              id,
              { kind: 'publishChapter', input: body },
              hostedPublicationPointSelectionReads(deps, id, context),
              commandContext(request, job.deadline),
            ),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'replacePublishedChapter'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedReplacePublishedChapterSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.replace_published_chapter' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = { actor, deadline: job.deadline };
        const result = await operation(() =>
          admission.run('normal', job, () =>
            publishHostedPublicationPoint(
              deps,
              actor,
              id,
              { kind: 'replacePublishedChapter', input: body },
              hostedPublicationPointSelectionReads(deps, id, context),
              commandContext(request, job.deadline),
            ),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'advanceLegacyPublicBaseline'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedLegacyPublicBaselineSchema),
        response: {
          200: withHeaders(HostedLegacyPublicBaselineProgressSchema, responseHeaders),
          ...failures(),
        },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.advance_legacy_public_baseline' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            advanceHostedLegacyPublicBaseline(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/hostedCatalogues/:id', 'publish'),
      {
        params: params(),
        headers,
        body: strictContentSchema(HostedPublishSchema),
        response: { 200: withHeaders(strictContentSchema(HostedCommandSchema), responseHeaders), ...failures() },
        detail: { ...writeDetail(), operationId: 'hosted_catalogue.publish' },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            publishHostedCatalogue(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/hostedCatalogues/:id',
      {
        params: params(),
        query: strictContentSchema(HostedCatalogueQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedRevisionSchema), responseHeaders), ...failures() },
        detail: { ...readDetail, operationId: 'hosted_catalogue.get' },
      },
      async ({ actor, params: { id }, query, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () => readHostedCatalogue(deps, id, query, { actor, deadline: job.deadline })),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/history',
      {
        params: params(),
        query: strictContentSchema(HostedHistoryQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedHistoryPageSchema), responseHeaders), ...failures() },
        detail: {
          'x-exposure': 'public',
          'x-resource-types': ['content.post'],
          'x-action': 'post:revise',
          security: [{ bearerAuth: [] }],
          operationId: 'hosted_catalogue.history',
        },
      },
      async ({ actor, params: { id }, query, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const { limit, ...paging } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            listHostedCatalogueHistory(
              deps,
              id,
              { ...paging, ...(limit === undefined ? {} : { limit: Number(limit) }) },
              { actor, deadline: job.deadline },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/outline',
      {
        params: params(),
        query: strictContentSchema(HostedOutlineQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedPageSchema), responseHeaders), ...failures() },
        detail: {
          'x-exposure': 'public',
          'x-resource-types': ['content.post'],
          'x-action': 'post:revise',
          security: [{ bearerAuth: [] }],
          operationId: 'hosted_catalogue.outline',
        },
      },
      async ({ actor, params: { id }, query, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const { limit, ...paging } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            listHostedAuthorOutline(
              deps,
              id,
              { ...paging, ...(limit === undefined ? {} : { limit: Number(limit) }) },
              { actor, deadline: job.deadline },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/children',
      {
        params: params(),
        query: strictContentSchema(HostedChildrenQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedPageSchema), responseHeaders), ...failures() },
        detail: { ...readDetail, operationId: 'hosted_catalogue.children' },
      },
      async ({ actor, params: { id }, query, admission, job, session, set }) => {
        const { limit, ...selection } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            listHostedChildren(
              deps,
              id,
              { ...selection, ...(limit === undefined ? {} : { limit: Number(limit) }) },
              { actor, deadline: job.deadline },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/occurrences/:occurrenceId',
      {
        params: occurrenceParams(),
        query: strictContentSchema(HostedSelectionSchema),
        response: { 200: withHeaders(strictContentSchema(HostedResolutionSchema), responseHeaders), ...failures() },
        detail: { ...readDetail, operationId: 'hosted_catalogue.resolve' },
      },
      async ({ actor, params: { id, occurrenceId }, query, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            resolveHostedOccurrence(deps, id, occurrenceId, query, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/occurrences/:occurrenceId/metadata',
      {
        params: occurrenceParams(),
        query: strictContentSchema(HostedSelectionSchema),
        response: {
          200: withHeaders(strictContentSchema(HostedOccurrenceMetadataSchema), responseHeaders),
          ...failures(),
        },
        detail: { ...readDetail, operationId: 'hosted_catalogue.resolve_metadata' },
      },
      async ({ actor, params: { id, occurrenceId }, query, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            resolveHostedOccurrenceMetadata(deps, id, occurrenceId, query, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/hostedCatalogues/:id/occurrences/:occurrenceId/navigation',
      {
        params: occurrenceParams(),
        query: strictContentSchema(HostedNavigationQuerySchema),
        response: { 200: withHeaders(strictContentSchema(HostedPageSchema), responseHeaders), ...failures() },
        detail: { ...readDetail, operationId: 'hosted_catalogue.navigate' },
      },
      async ({ actor, params: { id, occurrenceId }, query, admission, job, session, set }) => {
        const { limit, ...selection } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            navigateHostedChapters(
              deps,
              id,
              { ...selection, occurrenceId, ...(limit === undefined ? {} : { limit: Number(limit) }) },
              { actor, deadline: job.deadline },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    )
    .get(
      '/v1/subjects/:id/hostedCatalogues',
      {
        params: params(),
        query: strictContentSchema(hostedSubjectCatalogueQuerySchema()),
        response: {
          200: withHeaders(strictContentSchema(hostedSubjectCataloguePageSchema()), responseHeaders),
          ...failures(),
        },
        detail: { ...readDetail, operationId: 'hosted_catalogue.for_subject' },
      },
      async ({ actor, params: { id }, query, admission, job, session, set }) => {
        const { limit, ...rest } = query;
        const result = await operation(() =>
          admission.run('normal', job, () =>
            listHostedCataloguesForSubject(
              deps,
              id,
              { ...rest, ...(limit === undefined ? {} : { limit: Number(limit) }) },
              { actor, deadline: job.deadline },
            ),
          ),
        );
        for (const anchor of result.anchors)
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        set.headers['cache-control'] = 'private, no-store';
        return { ...result.value, items: [...result.value.items] };
      },
    );
}
