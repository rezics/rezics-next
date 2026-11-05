import { withHeaders } from '@elysia/openapi';
import { SourceSchema } from '@rezics/definitions/bulk';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { resourceAuthorization } from '../../access/resource-authorization.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { SESSION_HEADER } from '../../http/request.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { accessCheck, AuthenticationError, type Access } from '../../request/access.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import type { WorkClient } from '../../work/client.ts';
import { editorialContextAnchor, publicContextEligibility, readContext, ContextNotFoundError } from '../context.ts';
import { GLOBAL_CONTEXT } from '../definitions.ts';
import { subjectReadEligibility } from '../eligibility.ts';
import { PageCursorError } from '../page.ts';
import {
  listProviderReviewQueue,
  prepareProviderReviewQueue,
  ProviderReviewNotFoundError,
  ProviderReviewNotReadyError,
  type ProviderReviewCandidate,
} from '../provider-review-queue.ts';
import { withReadTransaction } from '../../access/read-transaction.ts';
import { readStatementAs } from '../statement-disclosure.ts';
import type { subjectRoutes } from './subjects.ts';

const scope = {
  source: SourceSchema.properties.source,
  context: t.Optional(t.String({ format: 'uuid' })),
  status: t.Optional(t.Union([t.Literal('pending'), t.Literal('accepted_unselected')])),
};
export const ProviderReviewQuerySchema = t.Object(
  {
    ...scope,
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);
export const ProviderReviewPrepareSchema = t.Object(scope, { additionalProperties: false });

/** Reuse the mounted native schemas themselves; no second statement/candidate/freshness vocabulary. */
export function providerReviewSchemas(app: ReturnType<typeof subjectRoutes>) {
  function response(path: string) {
    const route = app.routes.find((route) => route.method === 'GET' && route.path === path);
    const schema = (route?.hooks.response as Record<number, unknown> | undefined)?.[200] as
      | {
          properties: Record<string, import('typebox').TSchema & { items?: import('typebox').TSchema }>;
        }
      | undefined;
    if (!schema?.properties) throw new TypeError(`Missing native review schema: ${path}`);
    return schema.properties;
  }
  const native = response('/v1/subjects/:id/candidates');
  const links = response('/v1/subjects/:id/links');
  return {
    candidate: t.Unsafe<ProviderReviewCandidate['candidate']>(native.candidates!.items!),
    adoption: t.Unsafe<ProviderReviewCandidate['adoption']>(native.adoption!),
    freshness: t.Unsafe<{ consistency: 'eventual'; target_seconds: 10; caught_up: boolean }>(links.freshness!),
  };
}

function failure(error: unknown): never {
  if (error instanceof ProviderReviewNotFoundError || error instanceof ContextNotFoundError)
    throw new ProblemError('not_found');
  if (error instanceof ProviderReviewNotReadyError) throw new ProblemError('semantic_not_ready');
  if (error instanceof PageCursorError) throw new ProblemError('invalid_request');
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  throw error;
}
const errors = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  503: problemSchema('semantic_not_ready', 'overloaded', 'partition_unavailable', 'deadline_exceeded'),
};

export function providerReviewQueueRoutes(
  app: ReturnType<typeof subjectRoutes>,
  deps: {
    pool: Pool;
    tokens: KeyRing;
    routeKey: Uint8Array;
    access: () => Access;
    workClient: () => Promise<WorkClient>;
  },
) {
  const native = providerReviewSchemas(app);
  const privateHeaders = { 'cache-control': t.Literal('private, no-store'), [SESSION_HEADER]: t.String() };
  return app
    .get(
      '/v1/review-candidates',
      {
        query: ProviderReviewQuerySchema,
        response: {
          200: withHeaders(
            t.Object(
              {
                candidates: t.Array(
                  t.Object(
                    {
                      subject: t.String({ format: 'uuid' }),
                      candidate: native.candidate,
                      adoption: native.adoption,
                    },
                    { additionalProperties: false },
                  ),
                ),
                next: t.Union([t.String(), t.Null()]),
                freshness: native.freshness,
              },
              { additionalProperties: false },
            ),
            privateHeaders,
          ),
          202: withHeaders(t.Object({ next: t.String() }, { additionalProperties: false }), {
            ...privateHeaders,
            'retry-after': t.String(),
          }),
          ...errors,
        },
        detail: {
          operationId: 'provider_review.list',
          'x-exposure': 'public',
          'x-action': 'context:accept',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, query, authorize, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        set.headers['cache-control'] = 'private, no-store';
        const context = query.context ?? GLOBAL_CONTEXT;
        const route = routeOf(context);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: context };
        const authorizeContext = async () => {
          const read = await accessCheck(
            deps.access(),
            actor,
            'context:read',
            { ...resource, eligibility: publicContextEligibility(resource) },
            { pool: deps.pool, deadline: job.deadline },
          );
          if (!(await readContext(deps.pool, context, read))) throw new ProviderReviewNotFoundError();
          const accept = await authorize(resource);
          if (!(await withReadTransaction(deps.pool, accept))) throw new ProblemError('forbidden');
        };
        try {
          const result = await admission.run('normal', job, () =>
            readStatementAs(deps.pool, deps.access(), actor, job.deadline, () =>
              listProviderReviewQueue(deps.pool, deps.tokens, {
                source: query.source,
                context,
                status: query.status ?? 'pending',
                limit: query.limit ?? 20,
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                viewer: `${actor.accountId}:${actor.clientId}:${actor.authnEpoch}`,
                routeKey: deps.routeKey,
                authorizeContext,
                seen: [...session.components],
                authorizeSubject: (id) => {
                  const subject = { route: routeOf(id)!, id };
                  return accessCheck(
                    deps.access(),
                    actor,
                    'subject:read',
                    { ...subject, eligibility: subjectReadEligibility(subject) },
                    { pool: deps.pool, deadline: job.deadline },
                  );
                },
              }),
            ),
          );
          if (result.kind === 'preparing') {
            set.status = 202;
            set.headers['retry-after'] = '2';
            return { next: result.next };
          }
          session.record(result.component);
          return { candidates: result.candidates, next: result.next, freshness: result.freshness };
        } catch (error) {
          return failure(error);
        }
      },
    )
    .post(
      customMethod('/v1/review-candidates', 'prepare'),
      {
        body: ProviderReviewPrepareSchema,
        response: {
          202: withHeaders(t.Object({ preparing: t.Literal(true) }, { additionalProperties: false }), {
            'retry-after': t.String(),
            'cache-control': t.Literal('private, no-store'),
          }),
          ...errors,
        },
        detail: {
          operationId: 'provider_review.prepare',
          'x-exposure': 'public',
          'x-action': 'context:accept',
          security: [{ bearerAuth: [] }],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ actor, body, admission, job, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        set.headers['cache-control'] = 'private, no-store';
        const context = body.context ?? GLOBAL_CONTEXT;
        if (routeOf(context) === null) throw new ProblemError('not_found');
        try {
          const anchor = editorialContextAnchor(context);
          const read = await accessCheck(
            deps.access(),
            actor,
            'context:read',
            { ...anchor.resource, eligibility: publicContextEligibility(anchor.resource) },
            { pool: deps.pool, deadline: job.deadline },
          );
          if (!(await readContext(deps.pool, context, read))) throw new ProviderReviewNotFoundError();
          const authorization = resourceAuthorization({
            access: deps.access(),
            actor,
            action: 'context:accept',
            anchor,
            context: { pool: deps.pool, deadline: job.deadline, partition: partitionOf(anchor.resource.route) },
          });
          const work = await deps.workClient();
          await admission.run('normal', job, () =>
            prepareProviderReviewQueue(deps.pool, work, {
              source: body.source,
              context,
              status: body.status ?? 'pending',
              actor,
              authorization,
              deadline: job.deadline,
            }),
          );
          set.status = 202;
          set.headers['retry-after'] = '2';
          return { preparing: true as const };
        } catch (error) {
          return failure(error);
        }
      },
    );
}
