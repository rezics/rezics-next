import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { threadTarget } from './commands.ts';
import { mutateContentPoint } from './erase-post.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  reserveMedia,
  NewThreadTargetExistsError,
  completeMedia,
  readReservation,
  decideDownload,
  type MediaDependencies,
  type DownloadVariant,
} from './media.ts';
import {
  MediaReservationInputSchema,
  MediaCompletionInputSchema,
  MediaReservationResponseSchema,
  MediaCompletionResponseSchema,
  MediaDownloadQuerySchema,
  MediaDownloadResponseSchema,
  strictContentSchema,
} from './schemas.ts';

type Dependencies = MediaDependencies & { routeKey: Uint8Array };
const params = t.Object({ id: t.String() }, { additionalProperties: false });
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
  409: problemSchema('conflict'),
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
const upload = defineRateLimit({ family: 'upload', units: 1 });
const write = defineRateLimit({ family: 'write', units: 1 });
const secured = [{ bearerAuth: [] }];
function context(request: Request, deadline: number) {
  return {
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    deadline,
    requestId: Bun.randomUUIDv7(),
  };
}
function existing(id: string) {
  if (routeOf(id) === null) throw new ProblemError('not_found');
}
async function mutation<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof NewThreadTargetExistsError) throw new ProblemError('conflict');
    throw error;
  }
}
function metadata(media: NonNullable<Awaited<ReturnType<typeof readReservation>>>) {
  if (media.purpose !== 'post-image') throw new ProblemError('not_found');
  return {
    id: media.id,
    state: media.erased ? ('erased' as const) : media.state,
    byteCount: media.byteCount,
    mediaType: media.mediaType,
    sha256: media.sha256,
    containerId: media.containerId,
    uploaderId: media.uploaderId,
    key: media.key,
    reservationRequestId: media.reservationRequestId,
  };
}

export function mediaRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  return app
    .post(
      '/v1/media',
      {
        body: strictContentSchema(MediaReservationInputSchema),
        headers: commandHeaders,
        response: {
          201: withHeaders(strictContentSchema(MediaReservationResponseSchema), {
            ...sessionHeader,
            location: t.String(),
          }),
          ...writeFailures,
        },
        detail: {
          operationId: 'media.create',
          'x-exposure': 'public',
          'x-action': 'media:create',
          'x-resource-types': ['content.media'],
          'x-rate-limit': upload,
          security: secured,
        },
      },
      async ({ actor, body, request, admission, job, session, status, set }) =>
        mutation(() =>
          admission.run('normal', job, async () => {
            if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
            const target =
              'newThread' in body
                ? {
                    thread: threadTarget(dependencies.routeKey, actor.accountId, body.newThread.idempotencyKey),
                    boardId: body.newThread.boardId,
                  }
                : undefined;
            const result = await reserveMedia(dependencies, actor, body, context(request, job.deadline), target);
            session.record(result);
            const media = await readReservation(dependencies, result.value.mediaId, { actor, deadline: job.deadline });
            if (!media) throw new ProblemError('not_found');
            set.headers.location = `/v1/media/${media.id}`;
            set.headers['cache-control'] = 'private, no-store';
            return status(201, { media: metadata(media) });
          }),
        ),
    )
    .get(
      '/v1/media/:id',
      {
        params,
        response: {
          200: withHeaders(strictContentSchema(MediaReservationResponseSchema), sessionHeader),
          ...readFailures,
        },
        detail: {
          operationId: 'media.read_reservation',
          'x-exposure': 'public',
          'x-action': 'media:read_reservation',
          security: secured,
        },
      },
      async ({ params: { id }, actor, admission, job, set }) =>
        admission.run('normal', job, async () => {
          existing(id);
          set.headers['cache-control'] = 'private, no-store';
          const media = await readReservation(dependencies, id, {
            actor,
            deadline: job.deadline,
          });
          if (!media) throw new ProblemError('not_found');
          return { media: metadata(media) };
        }),
    )
    .post(
      customMethod('/v1/media/:id', 'complete'),
      {
        params,
        body: strictContentSchema(MediaCompletionInputSchema),
        headers: commandHeaders,
        response: {
          200: withHeaders(strictContentSchema(MediaCompletionResponseSchema), sessionHeader),
          ...writeFailures,
        },
        detail: {
          operationId: 'media.complete',
          'x-exposure': 'public',
          'x-action': 'media:complete',
          'x-rate-limit': write,
          security: secured,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session, set }) =>
        mutation(() =>
          admission.run('normal', job, async () => {
            existing(id);
            if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
            const result = await completeMedia(dependencies, actor, id, body, context(request, job.deadline));
            session.record(result);
            set.headers['cache-control'] = 'private, no-store';
            return {
              media: { id: result.value.mediaId, state: result.value.state },
            };
          }),
        ),
    )
    .delete(
      '/v1/media/:id',
      {
        params,
        headers: commandHeaders,
        response: {
          204: withHeaders(t.Void(), sessionHeader),
          ...writeFailures,
        },
        detail: {
          operationId: 'media.erase',
          'x-exposure': 'public',
          'x-action': 'media:erase',
          'x-rate-limit': write,
          security: secured,
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        existing(id);
        await mutation(async () => {
          const result = await admission.run('normal', job, () =>
            mutateContentPoint(
              dependencies,
              actor,
              { action: 'media:erase', kind: 'media', id, reason: 'Author deletion' },
              context(request, job.deadline),
            ),
          );
          session.record(result);
          set.status = 204;
        });
      },
    )
    .get(
      customMethod('/v1/media/:id', 'authorizeDownload'),
      {
        params,
        query: strictContentSchema(MediaDownloadQuerySchema),
        response: {
          200: withHeaders(strictContentSchema(MediaDownloadResponseSchema), sessionHeader),
          ...readFailures,
        },
        detail: {
          operationId: 'media.authorize_download',
          'x-exposure': 'public',
          'x-action': 'media:read',
          security: [...secured, {}],
        },
      },
      async ({ params: { id }, query, actor, admission, job, set }) =>
        admission.run('normal', job, async () => {
          existing(id);
          set.headers['cache-control'] = 'private, no-store';
          const decision = await decideDownload(
            { ...dependencies, downloadContext: { deadline: job.deadline, routeKey: dependencies.routeKey } },
            id,
            actor,
            query.variant as DownloadVariant,
          );
          if (!decision.allowed) throw new ProblemError('not_found');
          set.headers['cache-control'] = decision.cacheControl;
          return decision;
        }),
    );
}
