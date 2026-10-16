import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { readZoneChapters, readZoneDecisions, readZoneWorks } from '../modules/zone-modules/read.ts';
import { readZoneReplies } from '../modules/zone-modules/replies.ts';
import { readZoneGenres } from '../modules/zone-modules/genres.ts';
import { discoveryError } from '../modules/discovery/management.ts';
import { readZoneEditorLists } from '../modules/zone-modules/editor-lists.ts';
import { compileZoneBrowse, readZoneBrowse } from '../modules/zone-modules/browse.ts';
import { QueryRejected } from '../modules/query/compile.ts';
import { problem } from './problems.ts';
import { zoneBrowsePage, zoneBrowseQuery, zoneChapterPage, zoneDecisionPage, zoneEditorLists, zoneGenrePage,
  zoneReplyPage, zoneWorkPage, ZONE_MODULE_COST } from '../modules/zone-modules/contract.ts';
import { pageQuery, readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { publicWorkRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const params = t.Object({ realm: readUuid });
const query = t.Object({ limit: pageQuery.limit, cursor: pageQuery.cursor,
  language: t.Optional(readLanguage), actingSubject: t.Optional(readId) }, { additionalProperties: false });
const cardQuery = t.Object({ ...query.properties,
  work: t.Optional(t.Array(readId, { minItems: 1, maxItems: ZONE_MODULE_COST.pageSize, uniqueItems: true })),
}, { additionalProperties: false });
const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const headers = { 'cache-control': 'no-store' };
// Readers can send their usual identity query; publication reads select only
// public options, so an Agent or bearer never supplies Realm member authority.
function publicOptions(options: { limit?: number; cursor?: string; language?: string }) {
  return { limit: options.limit, cursor: options.cursor, language: options.language };
}
export const openApiOperations = {
  '/v1/realms/{realm}/modules/new-adoptions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/recently-completed': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/recent-decisions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/latest-chapters': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/discussions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/reader-quotes': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/genres/{context}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/editor-lists': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/modules/browse': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;

/** Zone modules are public publications; a stray bearer token cannot widen them. */
export function zoneModuleRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/realms/:realm/modules/new-adoptions', { params, query: cardQuery,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/new-adoptions"].get, { 200: zoneWorkPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneWorks(session, id(path.realm), 'new-adoptions', options.work)), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/recently-completed', { params, query,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/recently-completed"].get, { 200: zoneWorkPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneWorks(session, id(path.realm), 'recently-completed')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/recent-decisions', { params, query,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/recent-decisions"].get, { 200: zoneDecisionPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneDecisions(session, id(path.realm))), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/latest-chapters', { params, query,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/latest-chapters"].get, { 200: zoneChapterPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneChapters(session, id(path.realm))), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/discussions', { params, query,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/discussions"].get, { 200: zoneReplyPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneReplies(session, id(path.realm), 'discussions')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/reader-quotes', { params, query,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/reader-quotes"].get, { 200: zoneReplyPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneReplies(session, id(path.realm), 'reader-quotes')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/genres/:context', {
      params: t.Object({ realm: readUuid, context: readUuid }), query,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/genres/{context}"].get, { 200: zoneGenrePage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneGenres(session, id(path.realm), id(path.context))), { headers }); }
      catch (error) { return discoveryError(error); }
    })
    .get('/v1/realms/:realm/modules/editor-lists', {
      params, query: t.Object({ language: t.Optional(readLanguage), actingSubject: t.Optional(readId) },
        { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/editor-lists"].get, { 200: zoneEditorLists, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await publicWorkRead(work, request, publicOptions(options),
        session => readZoneEditorLists(session, id(path.realm))), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/browse', { params, query: zoneBrowseQuery,
      response: transportResponses(openApiOperations["/v1/realms/{realm}/modules/browse"].get, { 200: zoneBrowsePage, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try {
        const { actingSubject: _actingSubject, ...browse } = options;
        compileZoneBrowse(id(path.realm), browse);
        return Response.json(await publicWorkRead(work, request, publicOptions(browse),
        session => readZoneBrowse(session, id(path.realm), browse)), { headers });
      } catch (error) {
        if (error instanceof QueryRejected) return problem(400, error.refusal, error.message);
        return discoveryError(error);
      }
    });
}
