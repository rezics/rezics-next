import { Elysia, t } from 'elysia';
import { AUTHOR_PAGE_COST, authorWorksPage, externalAuthorRead } from '../modules/author-page/contract.ts';
import { readExternalAuthor, readExternalAuthorWorks } from '../modules/author-page/read.ts';
import { pageQuery, readQuery } from '../modules/work/read-contract.ts';
import { workRead, WorkReadLimit } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const params = t.Object({ author: t.String({ pattern: '^OL[1-9][0-9]{0,11}A$' }) });
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };

function response(value: unknown) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > AUTHOR_PAGE_COST.responseBytes) throw new WorkReadLimit('Author response exceeds budget');
  return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } });
}
function readError(error: unknown) {
  const result = workReadError(error);
  result.headers.set('cache-control', 'private, no-store');
  return result;
}

// Public reads: a bearer is optional and, with `actingSubject`, reads as that Agent.
export const openApiOperations = {
  '/v1/authors/open-library/{author}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/authors/open-library/{author}/works': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;

/** Author pages for Open Library authors credited on REZICS Works (`modules/author-page`). */
export function authorRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/authors/open-library/:author', { params, detail,
      query: t.Object({ ...readQuery, limit: pageQuery.limit }, { additionalProperties: false }),
      response: { 200: externalAuthorRead, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try {
        return response(await workRead(work, request, query,
          s => readExternalAuthor(s, `/authors/${path.author}`, query.limit)));
      } catch (error) { return readError(error); }
    })
    .get('/v1/authors/open-library/:author/works', { params, detail,
      query: t.Object(pageQuery, { additionalProperties: false }),
      response: { 200: authorWorksPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return response(await workRead(work, request, query, s => readExternalAuthorWorks(s, `/authors/${path.author}`))); }
      catch (error) { return readError(error); }
    });
}
