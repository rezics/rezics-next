import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/contract/errors.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { IDEMPOTENCY_HEADER } from '@rezics/operations/protocol';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { createVoteCommands } from '../rating/votes.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import type { Access, Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError } from './collection-command-work.ts';
import { createBangumiImport } from './list-import-bangumi.ts';
import {
  BANGUMI_LIMITS,
  type BangumiRow,
  type BangumiReview,
  type BangumiOutcome,
} from './list-import-bangumi-model.ts';
import {
  BANGUMI_LABEL_LIMITS,
  type BangumiLabelState,
  type BangumiLabelOutcome,
  type BangumiTagPage,
} from './list-import-bangumi-label-model.ts';
import { ENTRY_IMPORT_METADATA_LIMITS } from './list-import-entry-metadata.ts';

type Service = ReturnType<typeof createBangumiImport>;
type Output<K extends keyof Service> = Awaited<ReturnType<Service[K]>>;

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const ordinal = t.Integer({ minimum: 0, maximum: 99 });
const params = t.Object({ uploadId: id }, closed);
const metadataParams = t.Object({ uploadId: id, ordinal: t.Integer({ minimum: 0, maximum: 99 }) }, closed);
const metadataSelection = t.Object(
  {
    field: t.Union([
      t.Literal('note'),
      t.Literal('priority'),
      t.Literal('privacy'),
      t.Literal('sourceCreated'),
      t.Literal('sourceUpdated'),
    ]),
    action: t.Union([t.Literal('adopt'), t.Literal('clear')]),
    mapping: t.Optional(t.String({ maxLength: 64 })),
  },
  closed,
);
const scoreChoice = t.Union([
  t.Object({ action: t.Literal('preserve') }, closed),
  t.Object(
    { action: t.Literal('set'), units: t.Integer({ minimum: 0, maximum: 20 }), consent: t.Literal(true) },
    closed,
  ),
  t.Object({ action: t.Literal('clear'), consent: t.Literal(true) }, closed),
]);
const scoreSelection = t.Union([
  t.Object({ action: t.Literal('preserve') }, closed),
  t.Object({ action: t.Literal('set'), units: t.Integer({ minimum: 0, maximum: 20 }) }, closed),
  t.Object({ action: t.Literal('clear') }, closed),
]);
function headers() {
  return memoizedValue(headers, () => t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }));
}
const result = <T>() => t.Unsafe<T>(t.Any());
function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    422: problemSchema('idempotency_conflict'),
    503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
  }));
}
function detail(operationId: string, write = true) {
  return {
    operationId,
    'x-action': write ? 'library_entry:update' : 'library_entry:list',
    'x-exposure': 'gate:personal_library',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
async function admitted<T>(actor: Actor, run: () => Promise<T>): Promise<T> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    throw error;
  }
}
/** Web receives source evidence only through this owner-private, bounded surface. */
export function bangumiImportRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock: KernelClock;
  },
) {
  const engine = () => {
    const access = deps.access();
    return createBangumiImport({
      ...deps,
      access,
      votes: createVoteCommands({ pool: deps.pool, access, clock: deps.clock }),
    });
  };
  return app
    .post(
      customMethod('/v1/libraryImports/bangumi', 'preview'),
      {
        body: t.Object({ upload: t.String({ maxLength: BANGUMI_LIMITS.bytes }) }, closed),
        headers: headers(),
        response: { 200: t.Object({ uploadId: id, count: t.Integer() }), ...failures() },
        detail: detail('library_bangumi.preview'),
      },
      ({ actor, body, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().preview(actor, body.upload, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          ),
        );
      },
    )
    .get(
      '/v1/libraryImports/bangumi/:uploadId',
      {
        params,
        query: t.Object({ after: t.Optional(t.Integer({ minimum: -1, maximum: 99, default: -1 })) }, closed),
        response: {
          200: result<{ uploadId: string; cancelled: boolean; rows: BangumiRow[]; next: number | null }>(),
          ...failures(),
        },
        detail: detail('library_bangumi.read', false),
      },
      ({ actor, params, query, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () => engine().page(actor, params.uploadId, query.after ?? -1));
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'review'),
      {
        params,
        headers: headers(),
        body: t.Object({ ordinal, target: t.Optional(id), score: t.Optional(scoreSelection) }, closed),
        response: { 200: result<{ ordinal: number; review: BangumiReview | null }>(), ...failures() },
        detail: detail('library_bangumi.review'),
      },
      ({ actor, params, body, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().review(
              actor,
              params.uploadId,
              body.ordinal,
              body.target,
              body.score ?? { action: 'preserve' },
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          ),
        );
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'reviewMetadata'),
      {
        params,
        headers: headers(),
        body: t.Object({ ordinal, sourceReviewToken: id }, closed),
        response: { 200: result<{ ordinal: number; reviewToken: string }>(), ...failures() },
        detail: {
          ...detail('library_bangumi.review_metadata'),
          'x-body-limit': ENTRY_IMPORT_METADATA_LIMITS().requestBytes,
        },
      },
      ({ actor, params, body, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().reviewMetadata(
              actor,
              params.uploadId,
              body.ordinal,
              body.sourceReviewToken,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          ),
        );
      },
    )
    .get(
      '/v1/libraryImports/bangumi/:uploadId/metadata/:ordinal',
      {
        params: metadataParams,
        query: t.Object({ reviewToken: id }, closed),
        response: { 200: result<Output<'metadata'>>(), ...failures() },
        detail: detail('library_bangumi.read_metadata', false),
      },
      ({ actor, params, query, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () => engine().metadata(actor, params.uploadId, params.ordinal, query.reviewToken));
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'applyMetadata'),
      {
        params,
        body: t.Object(
          {
            ordinal,
            reviewToken: id,
            fields: t.Array(metadataSelection, {
              minItems: 1,
              maxItems: ENTRY_IMPORT_METADATA_LIMITS().fields,
              uniqueItems: true,
            }),
          },
          closed,
        ),
        response: { 200: result<Output<'applyMetadata'>>(), ...failures() },
        detail: {
          ...detail('library_bangumi.apply_metadata'),
          'x-body-limit': ENTRY_IMPORT_METADATA_LIMITS().requestBytes,
        },
      },
      ({ actor, params, body, request, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().applyMetadata(actor, params.uploadId, body.ordinal, body.reviewToken, body.fields, request.signal),
          ),
        );
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'apply'),
      {
        params,
        body: t.Object(
          {
            rows: t.Array(
              t.Object(
                {
                  ordinal,
                  reviewToken: id,
                  state: t.Union([t.Literal('preserve'), t.Literal('replace'), t.Literal('omit')]),
                  skip: t.Boolean(),
                  score: t.Optional(scoreChoice),
                },
                closed,
              ),
              { minItems: 1, maxItems: BANGUMI_LIMITS.apply, uniqueItems: true },
            ),
          },
          closed,
        ),
        response: {
          200: result<{ uploadId: string; outcomes: BangumiOutcome[]; remaining: number[] }>(),
          ...failures(),
        },
        detail: { ...detail('library_bangumi.apply'), 'x-body-limit': BANGUMI_LIMITS.applyRequestBytes },
      },
      ({ actor, params, body, request, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().apply(actor, params.uploadId, body.rows, request.signal, job.deadline),
          ),
        );
      },
    )
    .get(
      '/v1/libraryImports/bangumi/:uploadId/rows/:ordinal/tags',
      {
        params: t.Object({ uploadId: id, ordinal }, closed),
        query: t.Object(
          { after: t.Optional(t.Integer({ minimum: -1, maximum: BANGUMI_LIMITS.rowBytes, default: -1 })) },
          closed,
        ),
        response: { 200: result<BangumiTagPage>(), ...failures() },
        detail: detail('library_bangumi.tags', false),
      },
      ({ actor, params, query, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () => engine().tags(actor, params.uploadId, params.ordinal, query.after ?? -1));
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'reviewLabels'),
      {
        params,
        headers: headers(),
        body: t.Object(
          {
            ordinal,
            rowRevision: id,
            mappings: t.Array(
              t.Object(
                {
                  index: t.Integer({ minimum: 0, maximum: BANGUMI_LIMITS.rowBytes }),
                  target: t.Union([
                    t.Object({ labelId: id }, closed),
                    t.Object({ name: t.String({ maxLength: 8192 }) }, closed),
                  ]),
                },
                closed,
              ),
              { maxItems: BANGUMI_LABEL_LIMITS.selections },
            ),
          },
          closed,
        ),
        response: { 200: result<{ ordinal: number; labels: BangumiLabelState }>(), ...failures() },
        detail: detail('library_bangumi.review_labels'),
      },
      ({ actor, params, body, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().reviewLabels(
              actor,
              params.uploadId,
              body.ordinal,
              body.rowRevision,
              body.mappings,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          ),
        );
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'applyLabels'),
      {
        params,
        body: t.Object({ ordinal, reviewToken: id }, closed),
        response: {
          200: result<{ uploadId: string; ordinal: number; outcomes: BangumiLabelOutcome[]; remaining: number[] }>(),
          ...failures(),
        },
        detail: detail('library_bangumi.apply_labels'),
      },
      ({ actor, params, body, request, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().applyLabels(actor, params.uploadId, body.ordinal, body.reviewToken, request.signal, job.deadline),
          ),
        );
      },
    )
    .post(
      customMethod('/v1/libraryImports/bangumi/:uploadId', 'cancel'),
      {
        params,
        headers: headers(),
        response: { 200: t.Object({ uploadId: id, cancelled: t.Boolean() }), ...failures() },
        detail: detail('library_bangumi.cancel'),
      },
      ({ actor, params, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().cancel(actor, params.uploadId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          ),
        );
      },
    )
    .delete(
      '/v1/libraryImports/bangumi/:uploadId',
      {
        params,
        headers: headers(),
        response: { 200: t.Object({ deleted: t.Boolean() }), ...failures() },
        detail: detail('library_bangumi.delete'),
      },
      ({ actor, params, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admitted(actor, () =>
          admission.run('normal', job, () =>
            engine().remove(actor, params.uploadId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          ),
        );
      },
    );
}
