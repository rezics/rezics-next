import { Elysia, t } from 'elysia';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import { realmThread, realmThreadQuery, realmThreadsPage, realmThreadsQuery } from '../modules/realm-reply/thread-contract.ts';
import { readRealmThread, readRealmThreads } from '../modules/realm-reply/thread-read.ts';
import { RealmReplyInvalid } from '../modules/realm-reply/content-store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const headers = { 'cache-control': 'no-store' };

// Public reads: a private Realm answers only its members, who send a bearer
// token and the Agent they read as; the reader's own votes come back with it.
export const openApiOperations = {
  '/v1/realms/{realm}/threads': { get: { bearer: false } },
  '/v1/realms/{realm}/threads/{reply}': { get: { bearer: false } },
} as const;

function threadError(error: unknown): Response {
  if (error instanceof RealmReplyInvalid) return problem(400, 'invalid_realm_thread_read', error.message);
  return workReadError(error);
}

export function realmReplyThreadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/realms/:realm/threads', { params: t.Object({ realm: readUuid }), query: realmThreadsQuery,
      detail: { security: [{}, { bearerAuth: [] }] }, response: { 200: realmThreadsPage, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, query, session => readRealmThreads(session,
          id(params.realm), query)), { headers });
      } catch (error) { return threadError(error); }
    })
    .get('/v1/realms/:realm/threads/:reply', { params: t.Object({ realm: readUuid, reply: readUuid }),
      query: realmThreadQuery, detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: realmThread, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, query, session => readRealmThread(session,
          id(params.realm), id(params.reply), query.sort)), { headers });
      } catch (error) { return threadError(error); }
    });
}
