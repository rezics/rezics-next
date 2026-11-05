import { memoizedValue } from '../../memoized.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { PresentationProfile } from '@rezics/composition';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { AuthenticationError, type Access, type AccessFactory } from '../../request/access.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { pageRoutes } from './pages.ts';
import {
  activateProfile,
  activeProfile,
  ProfileAccessDeniedError,
  ProfileInputError,
  ProfileNotFoundError,
  publishProfile,
  readProfile,
  StaleProfileHeadError,
} from '../profiles.ts';
import { GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { readCurationOpening } from '../curation-advice.ts';

function resource() {
  return memoizedValue(resource, () => ({ route: 0, id: GLOBAL_CONTEXT }));
}
const digestResponse = t.Object({ digest: t.String() }, { additionalProperties: false });
const activeResponse = t.Object({ digest: t.String(), head: t.Integer() }, { additionalProperties: false });
const profileObject = t.Record(t.String(), t.Any());
const actionState = t.Union([t.Literal('allowed'), t.Literal('denied'), t.Literal('unavailable')]);
const curationOpeningResponse = t.Union([
  t.Object({ state: t.Literal('missing') }, { additionalProperties: false }),
  t.Object(
    {
      state: t.Literal('active'),
      viewer: t.Union([t.Literal('anonymous'), t.Literal('account')]),
      digest: t.String(),
      head: t.Integer({ minimum: 0 }),
      profile: profileObject,
      advice: t.Object({ publish: actionState, activate: actionState }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
]);
function writeHeaders() {
  return memoizedValue(writeHeaders, () =>
    t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
  );
}
function unauthorized() {
  return memoizedValue(unauthorized, () => problemSchema('authentication_required', 'invalid_credentials'));
}
function unavailable() {
  return memoizedValue(unavailable, () =>
    problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
  );
}
function sessionHeaders() {
  return memoizedValue(sessionHeaders, () => ({ [SESSION_HEADER]: t.String() }));
}

function profileProblem(error: unknown): never {
  if (error instanceof ProfileInputError)
    throw new ProblemError('invalid_request', {
      errors: error.violations.map(({ pointer, code }) => ({
        pointer: `/profile${pointer}`,
        code: code === 'limit' ? 'out_of_range' : code === 'unknown_type' ? 'unsupported' : 'invalid_format',
      })),
    });
  if (error instanceof ProfileAccessDeniedError) throw new ProblemError('forbidden');
  if (error instanceof ProfileNotFoundError) throw new ProblemError('not_found');
  if (error instanceof StaleProfileHeadError) throw new ProblemError('stale_editorial_head');
  throw error;
}

export function profileRoutes(
  app: ReturnType<typeof definitionRoutes>,
  {
    pool,
    access,
    tokens,
    routeKey,
  }: { pool: Pool; access?: Access | AccessFactory; tokens: KeyRing; routeKey: Uint8Array },
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  const profiles = app
    .post(
      '/v1/presentation/profiles',
      {
        headers: writeHeaders(),
        body: t.Object({ profile: t.Any() }, { additionalProperties: false }),
        response: {
          200: withHeaders(digestResponse, sessionHeaders()),
          201: withHeaders(digestResponse, sessionHeaders()),
          400: problemSchema('invalid_request'),
          401: unauthorized(),
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable(),
        },
        detail: {
          operationId: 'presentation.publish',
          'x-exposure': 'public',
          'x-action': 'presentation:publish',
          'x-authority-resource-types': ['semantic.context'],
          'x-authority-resource-id': GLOBAL_CONTEXT,
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(resource(), () => new ProfileAccessDeniedError());
        try {
          const result = await admission.run('normal', job, () =>
            publishProfile(pool, {
              actor,
              idempotencyKey: key,
              digest: requestDigest('presentation.publish', actor, { params: {}, body }),
              profile: body.profile,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          set.status = result.created ? 201 : 200;
          return { digest: result.digest };
        } catch (error) {
          return profileProblem(error);
        }
      },
    )
    .get(
      '/v1/presentation/profiles/:digest',
      {
        params: t.Object({ digest: t.String() }),
        response: {
          200: withHeaders(t.Object({ digest: t.String(), profile: profileObject }, { additionalProperties: false }), {
            etag: t.String(),
            'cache-control': t.String(),
          }),
          401: unauthorized(),
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'presentation.read_profile',
          'x-exposure': 'public',
          'x-action': 'presentation:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, authorize, admission, job, set }) => {
        const check = await authorize({
          ...resource(),
          ...(includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
        });
        const profile = await admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          return readProfile(pool, params.digest);
        });
        if (!profile) throw new ProblemError('not_found');
        set.headers.etag = `"${params.digest}"`;
        set.headers['cache-control'] = 'public, max-age=31536000, immutable';
        return { digest: params.digest, profile: profile as unknown as Record<string, unknown> };
      },
    )
    .get(
      '/v1/presentation/active',
      {
        response: {
          200: activeResponse,
          401: unauthorized(),
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'presentation.read_active',
          'x-exposure': 'public',
          'x-action': 'presentation:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ authorize, admission, job }) => {
        const check = await authorize({
          ...resource(),
          ...(includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
        });
        const active = await admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          return activeProfile(pool);
        });
        if (!active) throw new ProblemError('not_found');
        return { digest: active.digest, head: active.head };
      },
    )
    .get(
      '/v1/presentation/curation',
      {
        response: {
          200: withHeaders(curationOpeningResponse, { 'cache-control': t.String() }),
          401: unauthorized(),
          404: problemSchema('not_found'),
          409: problemSchema('stale_editorial_head'),
          503: problemSchema('overloaded', 'deadline_exceeded', 'dependency_unavailable'),
        },
        detail: {
          operationId: 'presentation.read_curation',
          'x-exposure': 'public',
          'x-action': 'presentation:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ actor, authorize, admission, job, headers, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const check = await authorize({
          ...resource(),
          ...(includeEligibility ? { eligibility: globalReadEligibility('presentation:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          const opening = await readCurationOpening({
            viewer: actor.kind,
            readActive: () => activeProfile(pool),
            readProfile: async (digest) => {
              const profile = await readProfile(pool, digest);
              if (!profile) throw new ProblemError('dependency_unavailable');
              return profile as PresentationProfile;
            },
            readViewerActions: async () => {
              const actionHeaders = new Headers({ 'content-type': 'application/json' });
              if (headers.authorization) actionHeaders.set('authorization', headers.authorization);
              const response = await app.handle(
                new Request('http://kernel.local/v1/viewerActions', {
                  method: 'POST',
                  headers: actionHeaders,
                  body: JSON.stringify({ resources: [{ type: 'semantic.context', id: GLOBAL_CONTEXT }] }),
                }),
              );
              if (!response.ok) throw new Error(`Viewer action read returned ${response.status}`);
              return response.json();
            },
          });
          if (opening.state === 'stale') throw new ProblemError('stale_editorial_head');
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          return opening;
        });
      },
    )
    .post(
      customMethod('/v1/presentation/profiles/:digest', 'activate'),
      {
        params: t.Object({ digest: t.String() }),
        headers: writeHeaders(),
        body: t.Object(
          { expected_head: t.Union([t.Integer({ minimum: 1, maximum: 2147483646 }), t.Null()]) },
          { additionalProperties: false },
        ),
        response: {
          200: withHeaders(activeResponse, sessionHeaders()),
          400: problemSchema('invalid_request'),
          401: unauthorized(),
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable(),
        },
        detail: {
          operationId: 'presentation.activate',
          'x-exposure': 'public',
          'x-action': 'presentation:activate',
          'x-authority-resource-types': ['semantic.context'],
          'x-authority-resource-id': GLOBAL_CONTEXT,
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(resource(), () => new ProfileAccessDeniedError());
        try {
          const result = await admission.run('normal', job, () =>
            activateProfile(pool, {
              actor,
              idempotencyKey: key,
              digest: requestDigest('presentation.activate', actor, { params, body }),
              profileDigest: params.digest,
              expectedHead: body.expected_head,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          return { digest: result.digest, head: result.head };
        } catch (error) {
          return profileProblem(error);
        }
      },
    );
  // Sub-reads dispatch through the kernel app. Every route is mounted before a request runs.
  return pageRoutes(profiles, {
    pool,
    routeKey,
    tokens,
    dispatch: (request) => app.handle(request),
    ...(access === undefined ? {} : { access }),
  });
}
