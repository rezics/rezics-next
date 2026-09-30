import { Elysia, t } from 'elysia';
import {
  entityPage,
  entityPageContext,
  subjectStatementPage,
} from '../modules/entity-page/contract.ts';
import { readEntityPage } from '../modules/entity-page/read.ts';
import {
  readSubjectStatements,
  SUBJECT_STATEMENT_COST,
} from '../modules/statement/subject-read.ts';
import { TargetNotBound, TargetUnavailable } from '../modules/target/resolve.ts';
import { RevisionCorrupt } from '../modules/work/history.ts';
import { pageQuery, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadLimit } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/resources/{id}/page': { get: { bearer: false } },
  '/v1/resources/{id}/statements': { get: { bearer: false } },
} as const;
const params = t.Object({ id: readUuid });
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
function response(body: unknown) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > SUBJECT_STATEMENT_COST.responseBytes) {
    throw new WorkReadLimit('Resource page response exceeds its byte budget');
  }
  return new Response(serialized, { headers: { ...headers, 'content-type': 'application/json' } });
}
function pageError(error: unknown) {
  if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
  if (error instanceof TargetUnavailable) return problem(404, error.code, error.message);
  if (error instanceof RevisionCorrupt)
    return problem(503, 'entity_page_unavailable', 'Resource page is unavailable');
  return workReadError(error);
}
export function entityPageRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get(
      '/v1/resources/:id/page',
      {
        params,
        detail,
        query: t.Object(readQuery, { additionalProperties: false }),
        response: { 200: entityPage, ...workReadProblems },
      },
      async ({ request, params: path, query }) => {
        try {
          return response(
            await workRead(work, request, query, (session) =>
              readEntityPage(session, `https://rezics.com/id/${path.id}`),
            ),
          );
        } catch (error) {
          return pageError(error);
        }
      },
    )
    .get(
      '/v1/resources/:id/statements',
      {
        params,
        detail,
        query: t.Object(
          { ...pageQuery, context: t.Optional(entityPageContext) },
          { additionalProperties: false },
        ),
        response: { 200: subjectStatementPage, ...workReadProblems },
      },
      async ({ request, params: path, query }) => {
        try {
          return response(
            await workRead(work, request, query, (session) =>
              readSubjectStatements(session, `https://rezics.com/id/${path.id}`, query.context),
            ),
          );
        } catch (error) {
          return pageError(error);
        }
      },
    );
}
