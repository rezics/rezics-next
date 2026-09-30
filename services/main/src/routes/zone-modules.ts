import { Elysia, t } from 'elysia';
import { readZoneChapters, readZoneDecisions, readZoneWorks } from '../modules/zone-modules/read.ts';
import { readZoneReplies } from '../modules/zone-modules/replies.ts';
import { readZoneGenres } from '../modules/zone-modules/genres.ts';
import { discoveryError } from '../modules/discovery/management.ts';
import { readZoneEditorLists } from '../modules/zone-modules/editor-lists.ts';
import { compileZoneBrowse, readZoneBrowse } from '../modules/zone-modules/browse.ts';
import { QueryRejected } from '../modules/query/compile.ts';
import { problem } from './problems.ts';
import { publicLanguageRequest } from '../modules/display-language/public-request.ts';
import { zoneBrowsePage, zoneBrowseQuery, zoneChapterPage, zoneDecisionPage, zoneEditorLists, zoneGenrePage,
  zoneReplyPage, zoneWorkPage } from '../modules/zone-modules/contract.ts';
import { pageQuery, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const params = t.Object({ realm: readUuid });
const query = t.Object({ limit: pageQuery.limit, cursor: pageQuery.cursor,
  language: t.Optional(readLanguage) }, { additionalProperties: false });
const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const headers = { 'cache-control': 'no-store' };
export const openApiOperations = {
  '/v1/realms/{realm}/modules/new-adoptions': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/recently-completed': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/recent-decisions': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/latest-chapters': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/discussions': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/reader-quotes': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/genres/{context}': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/editor-lists': { get: { bearer: false } },
  '/v1/realms/{realm}/modules/browse': { get: { bearer: false } },
} as const;

/** Zone modules are public publications; a stray bearer token cannot widen them. */
export function zoneModuleRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/realms/:realm/modules/new-adoptions', { params, query,
      response: { 200: zoneWorkPage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneWorks(session, id(path.realm), 'new-adoptions')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/recently-completed', { params, query,
      response: { 200: zoneWorkPage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneWorks(session, id(path.realm), 'recently-completed')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/recent-decisions', { params, query,
      response: { 200: zoneDecisionPage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneDecisions(session, id(path.realm))), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/latest-chapters', { params, query,
      response: { 200: zoneChapterPage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneChapters(session, id(path.realm))), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/discussions', { params, query,
      response: { 200: zoneReplyPage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneReplies(session, id(path.realm), 'discussions')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/reader-quotes', { params, query,
      response: { 200: zoneReplyPage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneReplies(session, id(path.realm), 'reader-quotes')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/genres/:context', {
      params: t.Object({ realm: readUuid, context: readUuid }), query,
      response: { 200: zoneGenrePage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneGenres(session, id(path.realm), id(path.context))), { headers }); }
      catch (error) { return discoveryError(error); }
    })
    .get('/v1/realms/:realm/modules/editor-lists', {
      params, query: t.Object({ language: t.Optional(readLanguage) }, { additionalProperties: false }),
      response: { 200: zoneEditorLists, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, publicLanguageRequest(request), options,
        session => readZoneEditorLists(session, id(path.realm))), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/realms/:realm/modules/browse', { params, query: zoneBrowseQuery,
      response: { 200: zoneBrowsePage, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try {
        compileZoneBrowse(id(path.realm), options);
        return Response.json(await workRead(work, publicLanguageRequest(request), { language: options.language,
          limit: options.limit, cursor: options.cursor },
        session => readZoneBrowse(session, id(path.realm), options)), { headers });
      } catch (error) {
        if (error instanceof QueryRejected) return problem(400, error.refusal, error.message);
        return discoveryError(error);
      }
    });
}
