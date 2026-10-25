import { Elysia } from 'elysia';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createAccess } from '../access/index.ts';
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
import { ProblemError, problemResponse } from './problem.ts';
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

export const REQUEST_DEADLINE_MS = 2000;

export function createApp({
  pool,
  admission = new Admission(),
  access = createAccess,
  tokens,
  writeRate = createWriteRateLimiter(),
  rateAttribution,
  ratePeer,
}: {
  pool: Pool;
  admission?: Admission;
  access?: Access | AccessFactory;
  tokens?: KeyRing;
  writeRate?: WriteRateLimiter;
  rateAttribution?: WriteRateStageOptions;
  /** Trusted transport attribution; never a request header resolver. */
  ratePeer?: (request: Request) => string | undefined;
}) {
  const sessionKeys = tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  const rateStage = createWriteRateStage(writeRate, rateAttribution);
  let socketPeer: (request: Request) => string | undefined = () => undefined;
  const originalRequests = new WeakMap<Request, Request>();
  const requestIds = new WeakMap<Request, string>();
  const arrivals = new WeakMap<Request, number>();
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
      arrivals.set(request, Date.now());
    })
    .onError('global', ({ error, request, route }) => {
      let action: string | undefined;
      try {
        action = actionLabelOfMountedRoute(mountedFor(request, typeof route === 'string' ? route : undefined));
      } catch {
        action = undefined;
      }
      return problemResponse(error, { method: request.method, id: idFor(request), ...(action ? { action } : {}) });
    })
    .derive(async ({ request, route, set }) => {
      const job = { deadline: (arrivals.get(request) ?? Date.now()) + REQUEST_DEADLINE_MS, signal: request.signal };
      const actor =
        request.headers.get('authorization') === null
          ? { kind: 'anonymous' as const }
          : await admission.run('reserved', job, async () => {
              try {
                return await actorOf(accessForApp(), request, { pool, deadline: job.deadline });
              } catch (error) {
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
        const checkedAccess: Access = {
          authenticate: (token, received) => currentAccess.authenticate(token, received),
          replayAuthorization: (checkedAction) => currentAccess.replayAuthorization?.(checkedAction),
          ...(prepare
            ? {
                prepare: (preparedActor, preparedAction, preparedResource, received) =>
                  admission.run('normal', job, () =>
                    prepare.call(currentAccess, preparedActor, preparedAction, preparedResource, received),
                  ),
              }
            : {}),
          authorize: (client, checkedActor, checkedAction, checkedResource, evidence, time) =>
            currentAccess.authorize(client, checkedActor, checkedAction, checkedResource, evidence, time),
        };
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
      if (
        ['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        detail?.['x-action'] === undefined &&
        detail?.['x-rate-limit'] === undefined
      )
        return;
      await admission.run('normal', job, () =>
        rateStage({
          request,
          route,
          body,
          mounted,
          context: { pool, actor, deadline: job.deadline },
          peer: ratePeer ? ratePeer(original) : (server?.requestIP(original)?.address ?? socketPeer(original)),
        }),
      );
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
    catalogue = mountedRouteCatalogue(mountedApp);
    const verbs = new Set(
      catalogue.routes.map((route) => customMethodVerb(route.path)).filter((verb) => verb !== undefined),
    );
    return (request) => {
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
    };
  });
  return app;
}
