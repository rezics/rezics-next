import { Elysia, t } from 'elysia';
import { pageQuery, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved,
  WorkReadUnavailable, workRead } from '../modules/work/read-session.ts';
import { realmDecisionsPage, realmHeader, realmWorksPage } from '../modules/realm-reads/read-contract.ts';
import { readRealmHeader } from '../modules/realm-reads/read-realm.ts';
import { readRealmWorks } from '../modules/realm-reads/read-works.ts';
import { readRealmDecisions } from '../modules/realm-reads/public-decision-index.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { workReadProblems } from './work-reads.ts';

const params = t.Object({ realm: readUuid });
const headers = { 'cache-control': 'no-store' };
const page = t.Object({ limit: pageQuery.limit, cursor: pageQuery.cursor }, { additionalProperties: false });
const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const publicRequest = (request: Request) => new Request(request.url);
function realmReadError(error: unknown): Response {
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_realm_read', error.message);
  if (error instanceof WorkReadMissing) return problem(404, 'realm_unavailable', 'Realm is unavailable');
  if (error instanceof WorkReadMoved) return problem(409, 'read_basis_changed', 'Restart from the first page');
  if (error instanceof WorkReadLimit) return problem(422, 'realm_read_budget_exceeded', 'Realm read exceeds its budget');
  if (error instanceof WorkReadUnavailable) return problem(503, 'realm_read_unavailable', 'Realm read is unavailable');
  return commandError(error);
}

// Public only: a bearer token does not grant a private Realm or roster read.
export const openApiOperations = {
  '/v1/realms/{realm}': { get: { bearer: false } },
  '/v1/realms/{realm}/works': { get: { bearer: false } },
  '/v1/realms/{realm}/decisions': { get: { bearer: false } },
} as const;

export function realmReadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/realms/:realm', {
      params, query: t.Object({ language: t.Optional(readLanguage) }, { additionalProperties: false }),
      response: { 200: realmHeader, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return Response.json(await workRead(work, publicRequest(request), query,
        session => readRealmHeader(session, id(path.realm))), { headers }); }
      catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm/works', {
      params, query: t.Object({ ...page.properties, language: t.Optional(readLanguage) },
        { additionalProperties: false }),
      response: { 200: realmWorksPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return Response.json(await workRead(work, publicRequest(request), query,
        session => readRealmWorks(session, id(path.realm))), { headers }); }
      catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm/decisions', { params, query: page,
      response: { 200: realmDecisionsPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return Response.json(await workRead(work, publicRequest(request), query,
        session => readRealmDecisions(session, id(path.realm))), { headers }); }
      catch (error) { return realmReadError(error); }
    });
}
