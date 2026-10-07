import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { MediaUnavailable } from '../modules/media/store.ts';
import { realmDirectoryPage, REALM_DIRECTORY_COST } from '../modules/realm-directory/contract.ts';
import { RealmDirectoryWarming } from '../modules/realm-directory/index.ts';
import { realmDirectoryLifecycle } from '../modules/realm-directory/worker.ts';
import { readRealmDirectory } from '../modules/realm-directory/read.ts';
import { readSharedVocabulary, SHARED_VOCABULARY_COST } from '../modules/realm-directory/vocabulary.ts';
import { pageQuery, readLanguage } from '../modules/work/read-contract.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMoved, WorkReadUnavailable, workRead }
  from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const errors = { 400: problemResult(400), 409: problemResult(409),
  422: problemResult(422), 503: problemResult(503) };
const query = t.Object({ limit: pageQuery.limit, cursor: pageQuery.cursor,
  language: t.Optional(readLanguage), q: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
  topic: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
  sort: t.Optional(t.Union([t.Literal('activity'), t.Literal('members'), t.Literal('newest'),
    t.Literal('growing')])) },
{ additionalProperties: false });
const headers = { 'cache-control': 'no-store' };
function publicRequest(request: Request): Request {
  const languageHeaders = new Headers();
  for (const name of ['accept-language', 'x-rezics-display-languages']) {
    const value = request.headers.get(name);
    if (value) languageHeaders.set(name, value);
  }
  return new Request(request.url, { headers: languageHeaders });
}

function directoryError(error: unknown): Response {
  if (error instanceof WorkReadUnavailable && error.cause instanceof RealmDirectoryWarming) {
    const response = problem(503, 'realm_directory_unavailable', 'Realm directory is unavailable');
    response.headers.set('retry-after', String(REALM_DIRECTORY_COST.retryAfterSeconds));
    return response;
  }
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_realm_directory', error.message);
  if (error instanceof WorkReadMoved) return problem(409, 'read_basis_changed', 'Restart from the first page');
  if (error instanceof WorkReadLimit) return problem(422, 'realm_directory_budget_exceeded', error.message);
  if (error instanceof WorkReadUnavailable || error instanceof MediaUnavailable) {
    return problem(503, 'realm_directory_unavailable', 'Realm directory is unavailable');
  }
  return commandError(error);
}

export const openApiOperations = { '/v1/realms': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/classification-vocabulary': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } } } as const;

export function realmDirectoryRoutes(work: MainWorkDependencies) {
  return new Elysia().use(realmDirectoryLifecycle(work)).get('/v1/classification-vocabulary', {
    detail: { deprecated: true, description: 'Deprecated. Use /v1/discovery/concepts for searchable, cursor-paged topics.' },
    query: t.Object({ language: t.Optional(readLanguage),
      q: t.Optional(t.String({ minLength: 1, maxLength: 80 })) }, { additionalProperties: false }),
    response: { 200: t.Object({ profile: t.Literal('shared-vocabulary-v1'),
      items: t.Array(t.Object({ id: t.String(), label: t.String() }),
        { maxItems: SHARED_VOCABULARY_COST.page }), hasMore: t.Boolean() }), ...errors },
  }, async ({ request, query: options }) => {
    try { return Response.json(await workRead(work, publicRequest(request), options,
      session => readSharedVocabulary(session, options.q)), { headers }); }
    catch (error) { return directoryError(error); }
  }).get('/v1/realms', { query,
    detail: { deprecated: true, description: 'Deprecated. Use the resource-list-v1 profile of /v1/query with the type Facet for communities.' },
    response: { 200: realmDirectoryPage, ...errors },
  }, async ({ request, query: options }) => {
    try {
      // A directory is public even if the caller carries an unrelated bearer token.
      return Response.json(await workRead(work, publicRequest(request), options,
        session => readRealmDirectory(session, { sort: options.sort ?? 'activity', q: options.q,
          topic: options.topic })), { headers });
    } catch (error) { return directoryError(error); }
  });
}
