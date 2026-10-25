import { Elysia } from 'elysia';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { access as installedAccess } from '../access/index.ts';
import { withConnection } from '../database/pool.ts';
import { accessCheck, actorOf, type Access, type Resource } from '../request/access.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { Admission } from './admission.ts';
import { ProblemError, problemResponse } from './problem.ts';
import { actionForRequest, SESSION_HEADER } from './request.ts';

export const REQUEST_DEADLINE_MS = 2000;

export function createApp({
  pool,
  admission = new Admission(),
  access = installedAccess,
  tokens,
}: {
  pool: Pool;
  admission?: Admission;
  access?: Access;
  tokens?: KeyRing;
}) {
  const sessionKeys = tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  const requestIds = new WeakMap<Request, string>();
  const arrivals = new WeakMap<Request, number>();
  let mountedApp: { routes: readonly { method: string; path: string; hooks?: { detail?: unknown } }[] };
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
    .onError('global', ({ error, request }) => problemResponse(error, { method: request.method, id: idFor(request) }))
    .derive(async ({ request, route, set }) => {
      const job = { deadline: (arrivals.get(request) ?? Date.now()) + REQUEST_DEADLINE_MS, signal: request.signal };
      const actor =
        request.headers.get('authorization') === null
          ? { kind: 'anonymous' as const }
          : await admission.run('reserved', job, () => actorOf(access, request, { pool, deadline: job.deadline }));

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

      return {
        admission,
        job,
        actor,
        session,
        authorize: (resource: Resource) => {
          const action = actionForRequest(mountedApp, request, route);
          const context = { pool, deadline: job.deadline };
          const prepare = access.prepare;
          const checkedAccess: Access = {
            authenticate: (token, received) => access.authenticate(token, received),
            ...(prepare
              ? {
                  prepare: (preparedActor, preparedAction, preparedResource, received) =>
                    admission.run('normal', job, () =>
                      prepare.call(access, preparedActor, preparedAction, preparedResource, received),
                    ),
                }
              : {}),
            authorize: (client, checkedActor, checkedAction, checkedResource, evidence) =>
              access.authorize(client, checkedActor, checkedAction, checkedResource, evidence),
          };
          return accessCheck(checkedAccess, actor, action, resource, context);
        },
      };
    })
    .get('/health', { detail: { hide: true } }, async ({ admission: lanes, job }) => {
      try {
        await lanes.run('reserved', job, () =>
          withConnection(pool, async (client) => {
            await client.query('SELECT 1');
          }),
        );
        return { status: 'ok' as const };
      } catch {
        throw new ProblemError('dependency_unavailable');
      }
    });
  mountedApp = app;
  return app;
}
