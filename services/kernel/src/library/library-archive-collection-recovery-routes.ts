import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { defineRateLimit } from '../http/rate-limit.ts';
import { problemSchema } from '../http/problem.ts';
import { idempotencyKeyOf, IDEMPOTENCY_HEADER } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { KernelClock } from '../clock.ts';
import { LIBRARY_ARCHIVE_LIMITS, LIBRARY_ARCHIVE_RECOVERY_LIMITS } from './library-archive.ts';
import { exportAuthorityTypes } from './library-export.ts';
import { createLibraryArchiveCollectionRecovery } from './library-archive-collection-recovery.ts';

const closed = { additionalProperties: false } as const;
const text = t.String();
const nullableText = t.Union([text, t.Null()]);
const id = t.String({ format: 'uuid' });
const exportSection = t.Union([
  t.Literal('entries'),
  t.Literal('labels'),
  t.Literal('assignments'),
  t.Literal('sessions'),
  t.Literal('holdings'),
  t.Literal('collections'),
  t.Literal('collectionPins'),
  t.Literal('bangumiUploads'),
  t.Literal('bangumiEvidence'),
  t.Literal('malImports'),
  t.Literal('units'),
  t.Literal('history'),
  t.Literal('occurrences'),
  t.Literal('malEvidence'),
]);
const manifestSchema = t.Object(
  {
    format: t.Literal('https://rezics.com/formats/library-export'),
    version: t.Literal(1),
    exportId: id,
    capturedAt: text,
    expiresAt: text,
    privacy: t.Literal('private'),
    completeness: t.Literal('supported-native-facts'),
    sections: t.Array(exportSection),
    omissions: t.Object(
      {
        trash: text,
        providerIdentifiers: text,
        personalImportEvidence: text,
        commerce: text,
        publication: text,
        reimport: text,
      },
      closed,
    ),
    fullExport: t.Literal(false),
    rows: t.Integer({ minimum: 0 }),
    recordBytes: t.Integer({ minimum: 0 }),
  },
  closed,
);
const coverage = t.Object(
  {
    section: exportSection,
    capture: t.Union([t.Literal('present'), t.Literal('empty')]),
    treatment: t.Union([t.Literal('requires-explicit-mapping'), t.Literal('retained-unsupported')]),
    rows: t.Integer({ minimum: 0 }),
    reason: text,
  },
  closed,
);
const mapping = t.Object({ sourceSubjectId: id, targetSubjectId: t.Union([id, t.Null()]) }, closed);
const reviewedMapping = t.Object(
  {
    sourceSubjectId: id,
    targetSubjectId: t.Union([id, t.Null()]),
    currentSubjectId: t.Union([id, t.Null()]),
    state: t.Union([t.Literal('mapped'), t.Literal('unresolved'), t.Literal('canonical-changed')]),
  },
  closed,
);
const state = t.Union([
  t.Literal('preview'),
  t.Literal('reviewed'),
  t.Literal('applying'),
  t.Literal('complete'),
  t.Literal('partial'),
  t.Literal('cancelled'),
  t.Literal('expired'),
]);
const pinStatus = t.Object(
  {
    state: t.Union([t.Literal('none'), t.Literal('pending'), t.Literal('applied'), t.Literal('unsupported')]),
    reason: nullableText,
  },
  closed,
);
const pinReview = t.Object(
  {
    state: t.Union([t.Literal('none'), t.Literal('pending'), t.Literal('applied'), t.Literal('unsupported')]),
    reason: nullableText,
    reviewedRevision: nullableText,
  },
  closed,
);
const confirmation = t.Union([
  t.Object({ reviewId: id, digest: t.String({ pattern: '^[0-9a-f]{64}$' }) }, closed),
  t.Null(),
]);
const statusFields = {
  uploadId: id,
  state,
  createdAt: nullableText,
  expiresAt: text,
  manifest: t.Union([manifestSchema, t.Null()]),
  coverage: t.Array(coverage),
  sourceRecordCount: t.Integer({ minimum: 0 }),
  selectedCollectionId: t.Union([id, t.Null()]),
  selectedOccurrences: t.Integer({ minimum: 0 }),
  cancelRequested: t.Boolean(),
  collectionId: t.Union([id, t.Null()]),
  confirmation,
  pin: pinStatus,
  sectionReasons: t.Record(t.String(), t.String()),
};
const status = t.Object(statusFields, closed);
const rootPageFields = { ...statusFields, next: nullableText };
const params = t.Object({ id }, closed);
const collectionParams = t.Object({ id, collectionId: id }, closed);
const pageQuery = t.Object(
  {
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: LIBRARY_ARCHIVE_RECOVERY_LIMITS.previewPage, multipleOf: 1 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  },
  closed,
);
const uploadBody = t.Object(
  { archiveBase64: t.String({ maxLength: Math.ceil(LIBRARY_ARCHIVE_LIMITS.uploadBytes / 3) * 4 }) },
  closed,
);
const reviewBody = t.Object(
  {
    collectionId: id,
    selectedOccurrenceIds: t.Array(id, {
      maxItems: LIBRARY_ARCHIVE_RECOVERY_LIMITS.selectedOccurrences,
      uniqueItems: true,
    }),
    mappings: t.Array(mapping, {
      maxItems: LIBRARY_ARCHIVE_RECOVERY_LIMITS.selectedOccurrences,
    }),
  },
  closed,
);
const reviewHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const applyBody = t.Object({ reviewId: id, digest: t.String({ pattern: '^[0-9a-f]{64}$' }) }, closed);
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'dependency_unavailable',
    'semantic_not_ready',
    'presentation_not_ready',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};
const collectionSummary = t.Object(
  {
    id,
    title: nullableText,
    description: nullableText,
    metadataValid: t.Boolean(),
    visibility: nullableText,
    membershipKind: nullableText,
    builtinKind: nullableText,
    presentationKind: nullableText,
    memberCount: t.Integer({ minimum: 0 }),
    orderedCount: t.Integer({ minimum: 0 }),
    eligible: t.Boolean(),
    membershipComplete: t.Boolean(),
    orderComplete: t.Boolean(),
    visibilityDisposition: text,
    unsupported: nullableText,
  },
  closed,
);
const collectionsPage = t.Object({ ...rootPageFields, collections: t.Array(collectionSummary) }, closed);
const collectionPreview = t.Object(
  {
    ...collectionSummary.properties,
    presentationDisposition: text,
  },
  closed,
);
const occurrencePreview = t.Object(
  {
    sourceOccurrenceId: id,
    sourceSubjectId: nullableText,
    note: nullableText,
    notePresent: t.Boolean(),
    noteValid: t.Boolean(),
    noteState: t.Union([
      t.Literal('missing'),
      t.Literal('invalid'),
      t.Literal('cleared'),
      t.Literal('empty'),
      t.Literal('value'),
    ]),
    orderKey: text,
    orderPresent: t.Boolean(),
    orderState: t.Union([t.Literal('supported'), t.Literal('unsupported')]),
  },
  closed,
);
const occurrencesPage = t.Object(
  {
    ...rootPageFields,
    collection: t.Union([collectionPreview, t.Null()]),
    occurrences: t.Array(occurrencePreview),
  },
  closed,
);
const reviewSummary = t.Object(
  {
    reviewId: id,
    digest: t.String(),
    epoch: t.Integer(),
    completeOrder: t.Boolean(),
    completeMembership: t.Boolean(),
    selectedOccurrences: t.Integer(),
    mappings: t.Array(reviewedMapping),
  },
  closed,
);
const reviewed = t.Object(
  {
    ...statusFields,
    review: t.Union([reviewSummary, t.Null()]),
    mappings: t.Array(reviewedMapping),
    completeOrder: t.Boolean(),
    completeMembership: t.Boolean(),
    pin: pinReview,
  },
  closed,
);
const outcome = t.Object(
  {
    sourceOccurrenceId: id,
    sourceSubjectId: nullableText,
    targetSubjectId: nullableText,
    nativeMemberId: t.Union([id, t.Null()]),
    note: nullableText,
    notePresent: t.Boolean(),
    noteValid: t.Boolean(),
    sourceNoteState: t.Union([
      t.Literal('missing'),
      t.Literal('invalid'),
      t.Literal('cleared'),
      t.Literal('empty'),
      t.Literal('value'),
    ]),
    orderKey: text,
    orderPresent: t.Boolean(),
    addState: t.Union([
      t.Literal('pending'),
      t.Literal('applied'),
      t.Literal('failed'),
      t.Literal('unresolved'),
      t.Literal('unsupported'),
    ]),
    noteState: t.Union([t.Literal('pending'), t.Literal('applied'), t.Literal('failed'), t.Literal('unsupported')]),
    orderState: t.Union([t.Literal('pending'), t.Literal('applied'), t.Literal('failed'), t.Literal('unsupported')]),
    outcomeReason: nullableText,
    outcome: t.Union([
      t.Literal('pending'),
      t.Literal('applied'),
      t.Literal('failed'),
      t.Literal('unresolved'),
      t.Literal('unsupported'),
      t.Literal('partial'),
    ]),
  },
  closed,
);
const outcomesPage = t.Object(
  {
    ...rootPageFields,
    collection: t.Union([t.Object({ id, visibility: t.Literal('private') }, closed), t.Null()]),
    outcomes: t.Array(outcome),
  },
  closed,
);
/** Elysia checks each JSONB-derived result against the declared response schema before sending it. */
function responseValue<S extends TSchema>(_schema: S, value: unknown): Static<S> {
  return value as Static<S>;
}
function detail(operationId: string, write = false) {
  return {
    operationId: `library_archive_collection_recovery.${operationId}`,
    'x-action': 'collection:read',
    'x-exposure': 'gate:collections',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': exportAuthorityTypes,
    // collection:read is shared with optionally anonymous collection reads; the owner gate rejects anonymous actors.
    security: [{ bearerAuth: [] }, {}],
    ...(operationId === 'create'
      ? { 'x-body-limit': Math.ceil(LIBRARY_ARCHIVE_LIMITS.uploadBytes / 3) * 4 + 128 }
      : {}),
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
function requestSignal(request: Request, signal?: AbortSignal) {
  return signal ? AbortSignal.any([request.signal, signal]) : request.signal;
}

export function libraryArchiveCollectionRecoveryRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: { pool: Pool; access: () => Access; tokens: KeyRing; routeKey: Uint8Array; clock: KernelClock },
) {
  const service = () => createLibraryArchiveCollectionRecovery({ ...deps, access: deps.access() });
  return app
    .post(
      '/v1/libraryArchiveCollectionRecoveries',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: uploadBody,
        response: { 200: status, ...failures },
        detail: detail('create', true),
      },
      async ({ request, actor, headers, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(
            status,
            await service().create(
              actor,
              body.archiveBase64,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              requestSignal(request, job.signal),
            ),
          ),
        );
      },
    )
    .get(
      '/v1/libraryArchiveCollectionRecoveries/:id',
      {
        params,
        response: { 200: status, ...failures },
        detail: detail('status'),
      },
      async ({ request, actor, params: path, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(status, await service().status(actor, path.id, requestSignal(request, job.signal))),
        );
      },
    )
    .get(
      '/v1/libraryArchiveCollectionRecoveries/:id/collections',
      {
        params,
        query: pageQuery,
        response: { 200: collectionsPage, ...failures },
        detail: detail('collections'),
      },
      async ({ request, actor, params: path, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(
            collectionsPage,
            await service().listCollections(actor, path.id, query, requestSignal(request, job.signal)),
          ),
        );
      },
    )
    .get(
      '/v1/libraryArchiveCollectionRecoveries/:id/collections/:collectionId/occurrences',
      {
        params: collectionParams,
        query: pageQuery,
        response: { 200: occurrencesPage, ...failures },
        detail: detail('occurrences'),
      },
      async ({ request, actor, params: path, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(
            occurrencesPage,
            await service().previewCollection(
              actor,
              path.id,
              path.collectionId,
              query,
              requestSignal(request, job.signal),
            ),
          ),
        );
      },
    )
    .post(
      '/v1/libraryArchiveCollectionRecoveries/:id/review',
      {
        params,
        headers: reviewHeaders,
        body: reviewBody,
        response: { 200: reviewed, ...failures },
        detail: detail('review', true),
      },
      async ({ request, actor, params: path, headers, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(
            reviewed,
            await service().review(
              actor,
              path.id,
              body,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              requestSignal(request, job.signal),
            ),
          ),
        );
      },
    )
    .post(
      '/v1/libraryArchiveCollectionRecoveries/:id/apply',
      {
        params,
        body: applyBody,
        response: { 200: status, ...failures },
        detail: detail('apply', true),
      },
      async ({ request, actor, params: path, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(status, await service().apply(actor, path.id, body, requestSignal(request, job.signal))),
        );
      },
    )
    .get(
      '/v1/libraryArchiveCollectionRecoveries/:id/outcomes',
      {
        params,
        query: pageQuery,
        response: { 200: outcomesPage, ...failures },
        detail: detail('outcomes'),
      },
      async ({ request, actor, params: path, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(
            outcomesPage,
            await service().outcomes(actor, path.id, query, requestSignal(request, job.signal)),
          ),
        );
      },
    )
    .delete(
      '/v1/libraryArchiveCollectionRecoveries/:id',
      {
        params,
        response: { 200: status, ...failures },
        detail: detail('cancel', true),
      },
      async ({ request, actor, params: path, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          responseValue(status, await service().cancel(actor, path.id, requestSignal(request, job.signal))),
        );
      },
    );
}
