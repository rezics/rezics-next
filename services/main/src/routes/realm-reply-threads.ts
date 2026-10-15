import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import { realmAboutThread, realmAboutThreadQuery, realmThread, realmThreadQuery, realmThreadsPage, realmThreadsQuery } from '../modules/realm-reply/thread-contract.ts';
import { PROFILE_CONTRIBUTION_COST, readProfileContributions, readRealmAboutThread, readRealmThread, readRealmThreads }
  from '../modules/realm-reply/thread-read.ts';
import { RealmReplyInvalid } from '../modules/realm-reply/content-store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const headers = { 'cache-control': 'no-store' };

// Public reads: a private Realm answers only its members, who send a bearer
// token and the Agent they read as; the reader's own votes come back with it.
export const openApiOperations = {
  '/v1/realms/{realm}/about-thread': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/realms/{realm}/threads': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/realms/{realm}/threads/{reply}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/agents/{id}/realm-contributions': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
} as const;

function threadError(error: unknown): Response {
  if (error instanceof RealmReplyInvalid) return problem(400, 'invalid_realm_thread_read', error.message);
  return workReadError(error);
}

export function realmReplyThreadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/realms/:realm/about-thread', { params: t.Object({ realm: readUuid }), query: realmAboutThreadQuery,
      detail: { security: [{}, { bearerAuth: [] }],
        summary: 'Find the canonical discussion about a resource in a Realm',
        description: 'Returns the opener identity and retained root revision, or thread: null when no discussion is visible. '
          + 'Load content through the existing thread reads. This lookup creates nothing, returns no collection or cursor, '
          + 'and has a 64 KiB response ceiling. Hidden and absent resources return the same 404; unavailable owners return 503.' },
      response: transportResponses(openApiOperations["/v1/realms/{realm}/about-thread"].get, { 200: realmAboutThread, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, query,
          session => readRealmAboutThread(session, id(params.realm), query.about)), { headers });
      } catch (error) { return threadError(error); }
    })
    .get('/v1/agents/:id/realm-contributions', { params: t.Object({ id: readUuid }),
      query: t.Object({ kind: t.Union([t.Literal('posts'), t.Literal('comments')]),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
        actingSubject: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })) },
      { additionalProperties: false }), detail: { security: [{}, { bearerAuth: [] }] },
      response: transportResponses(openApiOperations["/v1/agents/{id}/realm-contributions"].get, { 200: t.Object({ profile: t.Literal('agent-realm-contributions-v1'),
        kind: t.Union([t.Literal('posts'), t.Literal('comments')]),
        items: t.Array(t.Object({ reply: t.String(), realm: t.String(), parent: t.Nullable(t.String()),
          time: t.String(), title: t.Nullable(t.String()), excerpt: t.String(),
          /** The author's declaration. Absent when they did not mark it; the title never supplies it. */
          spoiler: t.Optional(t.Boolean()) }),
        { maxItems: PROFILE_CONTRIBUTION_COST.pageSize }),
        nextCursor: t.Nullable(t.String()), sourcePosition: t.Object({ datasetId: t.String(),
          dataEpoch: t.String(), sequence: t.String() }) }), ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try { return Response.json(await workRead(work, request, query,
        session => readProfileContributions(session, id(params.id), query.kind, query.cursor)), { headers }); }
      catch (error) { return threadError(error); }
    })
    .get('/v1/realms/:realm/threads', { params: t.Object({ realm: readUuid }), query: realmThreadsQuery,
      detail: { security: [{}, { bearerAuth: [] }] }, response: transportResponses(openApiOperations["/v1/realms/{realm}/threads"].get, { 200: realmThreadsPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, { ...query, localBasis: true, retainedBasis: true }, session => readRealmThreads(session,
          id(params.realm), query)), { headers });
      } catch (error) { return threadError(error); }
    })
    .get('/v1/realms/:realm/threads/:reply', { params: t.Object({ realm: readUuid, reply: readUuid }),
      query: realmThreadQuery, detail: { security: [{}, { bearerAuth: [] }] },
      response: transportResponses(openApiOperations["/v1/realms/{realm}/threads/{reply}"].get, { 200: realmThread, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, { ...query, localBasis: true, retainedBasis: true }, session => readRealmThread(session,
          id(params.realm), id(params.reply), query.sort, query.cursor)), { headers });
      } catch (error) { return threadError(error); }
    });
}
