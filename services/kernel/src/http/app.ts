import { Elysia, t, ValidationError } from 'elysia';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { isSuspendedAccountAuthenticationError } from '../access/authenticate.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { deriveAccess } from '../access/derived-access.ts';
import { createAccess } from '../access/index.ts';
import { admitExposure, PlatformClosedError } from '../access/gates/admission.ts';
import { withConnection } from '../database/pool.ts';
import {
  accessCheck,
  accessCommandAuthorization,
  actorOf,
  AuthenticationError,
  type Access,
  type AccessFactory,
  type Resource,
} from '../request/access.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { Admission } from './admission.ts';
import { customMethodVerb } from './custom-method.ts';
import { logInternalError, PROBLEM_TYPE_BASE, ProblemError, problemResponse } from './problem.ts';
import {
  actionCatalogue,
  actionLabelOfMountedRoute,
  actionOfMountedRoute,
  mountedRouteCatalogue,
  type MountedRoute,
  type MountedRouteCatalogue,
  SESSION_HEADER,
} from './request.ts';
import healthCheck from './health.sql';
import { createWriteRateLimiter, type WriteRateLimiter } from '../access/write-rate.ts';
import { createWriteRateStage, type WriteRateStageOptions } from '../access/write-rate-stage.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';

export const REQUEST_DEADLINE_MS = DEFAULT_REQUEST_DEADLINE_MS;

export function createApp({
  pool,
  requestDeadlineMs = REQUEST_DEADLINE_MS,
  admission = new Admission(),
  access = createAccess,
  tokens,
  writeRate = createWriteRateLimiter(),
  rateAttribution,
  ratePeer,
  clock,
}: {
  pool: Pool;
  requestDeadlineMs?: number;
  admission?: Admission;
  access?: Access | AccessFactory;
  tokens?: KeyRing;
  writeRate?: WriteRateLimiter;
  rateAttribution?: WriteRateStageOptions;
  /** Trusted transport attribution; never a request header resolver. */
  ratePeer?: (request: Request) => string | undefined;
  /** The kernel's single domain clock, shared by request admission and commands. */
  clock?: () => Date;
}) {
  if (!Number.isFinite(requestDeadlineMs) || requestDeadlineMs <= 0)
    throw new TypeError('Request deadline must be positive milliseconds');
  const requestClock = clock ?? (() => new Date());
  const sessionKeys = tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  const rateStage = createWriteRateStage(writeRate, rateAttribution);
  let socketPeer: (request: Request) => string | undefined = () => undefined;
  const originalRequests = new WeakMap<Request, Request>();
  const requestIds = new WeakMap<Request, string>();
  const jsonBodyChecks = new Map<string, () => ReturnType<typeof Compile>>();
  const invalidJsonBodies = new WeakMap<Request, ValidationError>();
  let mountedApp: { routes: readonly { method: string; path: string; hooks?: { detail?: unknown } }[] };
  let catalogue: MountedRouteCatalogue;
  const matchedRoutes = new WeakMap<Request, MountedRoute | undefined>();
  const mountedFor = (request: Request, route?: string): MountedRoute | undefined => {
    if (!matchedRoutes.has(request)) matchedRoutes.set(request, catalogue.find(request, route));
    return matchedRoutes.get(request);
  };
  let resolvedAccess: Access | undefined;
  const accessForApp = (): Access => {
    if (typeof access !== 'function') return access;
    if (!resolvedAccess) {
      // Routes are mounted after createApp returns, so build access on its first use.
      resolvedAccess = access({ actions: actionCatalogue(catalogue) });
    }
    return resolvedAccess;
  };
  const idFor = (request: Request): string => {
    let id = requestIds.get(request);
    if (!id) {
      id = Bun.randomUUIDv7();
      requestIds.set(request, id);
    }
    return id;
  };

  const app = new Elysia()
    .onRequest(({ request }) => {
      idFor(request);
    })
    .onError('global', ({ error, request, route }) => {
      let action: string | undefined;
      let mounted: MountedRoute | undefined;
      try {
        mounted = mountedFor(request, typeof route === 'string' ? route : undefined);
        action = actionLabelOfMountedRoute(mounted);
      } catch {
        mounted = undefined;
        action = undefined;
      }
      const detail = mounted?.hooks?.detail as Record<string, unknown> | undefined;
      if (isSuspendedAccountAuthenticationError(error) && action?.startsWith('zone:')) {
        // Zone's direct-public-read contract distinguishes a verified suspended actor from bad auth.
        // Other resources retain their native authentication response; no suspended actor is admitted.
        return problemResponse(new ProblemError('forbidden'), {
          method: request.method,
          id: idFor(request),
          action,
        });
      }
      if (error instanceof PlatformClosedError) {
        const read = action?.endsWith(':read') === true;
        const effectStatus =
          read || ['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()) ? 'not_applicable' : 'not_applied';
        return new Response(
          JSON.stringify({
            type: `${PROBLEM_TYPE_BASE}platform_closed`,
            title: 'Platform Closed',
            status: 403,
            code: 'platform_closed',
            retryable: false,
            effect_status: effectStatus,
            request_id: idFor(request),
          }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      if (
        error instanceof AuthenticationError &&
        error.status === 401 &&
        /(?:^|[\s,])error\s*=\s*(?:"invalid_token"|invalid_token)(?=$|[\s,])/i.test(error.challenge) &&
        typeof detail?.['x-exposure'] === 'string' &&
        detail['x-exposure'].startsWith('gate:')
      ) {
        // Reject invalid bearers before gate lookup without exposing token validity.
        return problemResponse(new AuthenticationError(401, 'Bearer'), {
          method: request.method,
          id: idFor(request),
          ...(action ? { action } : {}),
        });
      }
      // Native validation can fail before beforeHandle; retain the original body pointers.
      const bodyError = error instanceof ValidationError ? invalidJsonBodies.get(request) : undefined;
      const problem = problemResponse(bodyError ?? error, {
        method: request.method,
        id: idFor(request),
        ...(action ? { action } : {}),
      });
      // internal_error is the only 500 problem; log the cause the response hides, never request content.
      if (problem.status === 500) {
        logInternalError({
          requestId: idFor(request),
          method: request.method,
          route: mounted?.path ?? (typeof route === 'string' ? route : undefined),
          cause: bodyError ?? error,
        });
      }
      return problem;
    })
    .onTransform('global', ({ body, request, route }) => {
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) return;
      const mounted = mountedFor(request, route);
      const check = mounted && jsonBodyChecks.get(`${mounted.method} ${mounted.path}`)?.();
      if (check && !check.Check(body))
        invalidJsonBodies.set(request, new ValidationError('body', body, check.Errors(body), check.Type()));
    })
    .onBeforeHandle('global', ({ request }) => {
      // Parsing transforms can report size limits first; retain errors from before coercion.
      const error = invalidJsonBodies.get(request);
      if (error) throw error;
    })
    .derive(async ({ request, route, set }) => {
      const job = { deadline: deadlineFor(requestDeadlineMs), signal: request.signal };
      const actor =
        request.headers.get('authorization') === null || invalidJsonBodies.has(request)
          ? { kind: 'anonymous' as const }
          : await admission.run('reserved', job, async () => {
              try {
                return await actorOf(accessForApp(), request, { pool, deadline: job.deadline });
              } catch (error) {
                throwAccessUnavailable(error, job.deadline);
                if (error instanceof AuthenticationError) throw error;
                throw new AuthenticationError(401, 'Bearer error="invalid_token"');
              }
            });

      const scope = actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous';
      const encoded = request.headers.get(SESSION_HEADER);
      let components = encoded === null ? [] : (decodeSession(sessionKeys, scope, encoded) ?? []);
      const session = {
        get components(): SessionComponent[] {
          return components;
        },
        record(component: SessionComponent): void {
          components = mergeSession(components, component);
          set.headers[SESSION_HEADER] = encodeSession(sessionKeys, scope, components);
        },
      };

      const permission = () => {
        const currentAccess = accessForApp();
        const action = actionOfMountedRoute(mountedFor(request, route));
        const context = { pool, deadline: job.deadline };
        const prepare = currentAccess.prepare;
        const checkedAccess = deriveAccess(currentAccess, {
          ...(prepare
            ? {
                prepare: (preparedActor, preparedAction, preparedResource, received) =>
                  admission.run('normal', job, () =>
                    prepare.call(currentAccess, preparedActor, preparedAction, preparedResource, received),
                  ),
              }
            : {}),
        });
        return { checkedAccess, action, context };
      };
      return {
        admission,
        job,
        actor,
        session,
        authorize: (resource: Resource) => {
          const { checkedAccess, action, context } = permission();
          return accessCheck(checkedAccess, actor, action, resource, context);
        },
        authorizeCommand: (resource: Resource, denied: () => Error) => {
          const { checkedAccess, action, context } = permission();
          return accessCommandAuthorization(checkedAccess, actor, action, resource, context, denied);
        },
      };
    })
    .onBeforeHandle('global', async ({ request, route, body, actor, job, server }) => {
      const original = originalRequests.get(request) ?? request;
      const mounted = mountedFor(request, route);
      const detail = mounted?.hooks?.detail as Record<string, unknown> | undefined;
      const gated = typeof detail?.['x-exposure'] === 'string' && detail['x-exposure'].startsWith('gate:');
      if (
        !gated &&
        ['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        detail?.['x-action'] === undefined &&
        detail?.['x-rate-limit'] === undefined
      )
        return;
      await admission.run('normal', job, async () => {
        await admitExposure({
          pool,
          access: accessForApp,
          actor,
          route: mounted,
          deadline: job.deadline,
          clock: requestClock,
        });
        await rateStage({
          request,
          route,
          body,
          mounted,
          context: { pool, actor, deadline: job.deadline },
          peer: ratePeer ? ratePeer(original) : (server?.requestIP(original)?.address ?? socketPeer(original)),
        });
      });
    })
    .get('/health', { detail: { hide: true, ...{ 'x-exposure': 'public' } } }, async ({ admission: lanes, job }) => {
      try {
        await lanes.run('reserved', job, () =>
          withConnection(pool, async (client) => {
            await healthCheck.run(client, {});
          }),
        );
        return { status: 'ok' as const };
      } catch {
        throw new ProblemError('dependency_unavailable');
      }
    });
  mountedApp = app;
  socketPeer = (request) => app.server?.requestIP(request)?.address;
  app.wrap((handle) => {
    // Elysia 2.0.0-rc.0 applies coerceBody even with normalize:false.
    // Compile each route's original schemas on first use, before its coercing validation.
    // The first request must not spend its deadline compiling every unrelated route.
    const routes = app.routes;
    jsonBodyChecks.clear();
    for (const { method, path, hooks } of routes) {
      const schemas: TSchema[] = [];
      for (const declaration of [hooks, ...(hooks?.schemas ?? [])]) {
        let schema = declaration?.body;
        if (typeof schema === 'string') schema = app.models[schema as keyof typeof app.models];
        if (!schema) continue;
        if ('~standard' in schema) {
          const input = schema['~standard'].jsonSchema?.input;
          if (!input) continue;
          schema = input({ target: 'draft-2020-12' }) as TSchema;
        }
        schemas.push(schema as TSchema);
      }
      if (schemas.length) {
        let check: ReturnType<typeof Compile> | undefined;
        jsonBodyChecks.set(
          `${method} ${path}`,
          () => (check ??= Compile(app.models, schemas.length === 1 ? schemas[0]! : t.Intersect(schemas))),
        );
      }
    }
    catalogue = mountedRouteCatalogue(mountedApp, routes);
    const verbs = new Set(
      catalogue.routes.map((route) => customMethodVerb(route.path)).filter((verb) => verb !== undefined),
    );
    return (request) => {
      return withRequestDeadline(Date.now() + requestDeadlineMs, () => {
        const url = new URL(request.url);
        const path = url.pathname;
        // Also refuse encoded dollar signs so router aliases cannot expose internal routes.
        if (/\/(?:\$|%24)/i.test(path))
          return problemResponse(new ProblemError('not_found'), { method: request.method, id: idFor(request) });

        const colon = path.lastIndexOf(':');
        if (colon > path.lastIndexOf('/') && verbs.has(path.slice(colon + 1))) {
          url.pathname = `${path.slice(0, colon)}/$${path.slice(colon + 1)}`;
          const rewritten = new Request(url, request);
          originalRequests.set(rewritten, request);
          return handle(rewritten);
        }
        return handle(request);
      });
    };
  });
  return app;
}
