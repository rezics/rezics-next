import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { MediaUnavailable } from '../modules/media/store.ts';
import { realmDirectoryPage } from '../modules/realm-directory/contract.ts';
import { readRealmDirectory } from '../modules/realm-directory/read.ts';
import { pageQuery, readLanguage } from '../modules/work/read-contract.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMoved, WorkReadUnavailable, workRead }
  from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const errors = { 400: problemResult(400), 409: problemResult(409),
  422: problemResult(422), 503: problemResult(503) };
const query = t.Object({ limit: pageQuery.limit, cursor: pageQuery.cursor,
  language: t.Optional(readLanguage), q: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
  sort: t.Optional(t.Union([t.Literal('activity'), t.Literal('members'), t.Literal('newest')])) },
{ additionalProperties: false });
const headers = { 'cache-control': 'no-store' };

function directoryError(error: unknown): Response {
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_realm_directory', error.message);
  if (error instanceof WorkReadMoved) return problem(409, 'read_basis_changed', 'Restart from the first page');
  if (error instanceof WorkReadLimit) return problem(422, 'realm_directory_budget_exceeded', error.message);
  if (error instanceof WorkReadUnavailable || error instanceof MediaUnavailable) {
    return problem(503, 'realm_directory_unavailable', 'Realm directory is unavailable');
  }
  return commandError(error);
}

export const openApiOperations = { '/v1/realms': { get: { bearer: false } } } as const;

export function realmDirectoryRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/realms', { query,
    response: { 200: realmDirectoryPage, ...errors },
  }, async ({ request, query: options }) => {
    try {
      // A directory is public even if the caller carries an unrelated bearer token.
      return Response.json(await workRead(work, new Request(request.url), options,
        session => readRealmDirectory(session, { sort: options.sort ?? 'activity', q: options.q })), { headers });
    } catch (error) { return directoryError(error); }
  });
}
