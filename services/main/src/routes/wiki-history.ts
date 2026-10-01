import { Elysia, t } from 'elysia';
import { Value } from 'typebox/value';
import type { MainWorkDependencies } from './dependencies.ts';
import { groupUuid, groupAgent } from './shared.ts';
import { problem } from './problems.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { EditorialBlocked, EditorialInvalid } from '../modules/editorial-review/contract.ts';
import { WikiRevisionSetSchema, type WikiRevisionSet } from '../modules/wiki/delta.ts';
import { readWikiHistory } from '../modules/wiki/history-read.ts';
import { wikiError } from './wiki.ts';
import { readingPositionQuery } from './reading-positions.ts';

export const openApiOperations = { '/v1/wiki/{work}/history': { get: { bearer: true } } } as const;
export const capabilities = {
  '/v1/wiki/{work}/history': {
    get: {
      disposition: 'supported',
      mcp: {
        tool: 'wiki_history',
        scopes: ['work:read'],
        title: 'Read an accepted wiki revision set',
        description:
          'Read reviewed wiki claims at a reading position, retaining historical names and current quotation restrictions.',
      },
    },
  },
} as const;
export function wikiHistoryRoutes(work: MainWorkDependencies) {
  return new Elysia().get(
    '/v1/wiki/:work/history',
    {
      params: t.Object({ work: groupUuid }),
      query: t.Object({
        actingSubject: groupAgent,
        revisions: t.Optional(t.String({ maxLength: 16000 })),
        position: readingPositionQuery,
        entity: t.Optional(groupAgent),
        section: t.Optional(
          t.Union([
            t.Literal('characters'),
            t.Literal('places'),
            t.Literal('events'),
            t.Literal('chapters'),
          ]),
        ),
      }),
      response: {
        200: t.Object({}, { additionalProperties: true }),
        ...authorizedReadProblems,
        409: problemResult(409),
        422: problemResult(422),
      },
    },
    async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        let selection: WikiRevisionSet | undefined;
        if (query.revisions) {
          try {
            const raw: unknown = JSON.parse(query.revisions);
            if (!Value.Check(WikiRevisionSetSchema, raw)) throw new Error('Invalid pins');
            selection = raw;
          } catch {
            throw new EditorialInvalid('Invalid wiki revision set');
          }
        }
        return Response.json(
          await readWikiHistory(
            work,
            principal,
            query.actingSubject,
            `https://rezics.com/id/${params.work}`,
            selection,
            request,
            { entity: query.entity, section: query.section },
          ),
          { headers: { 'cache-control': 'no-store' } },
        );
      } catch (error) {
        if (error instanceof EditorialInvalid)
          return problem(400, 'invalid_wiki_history', error.message);
        if (error instanceof EditorialBlocked)
          return problem(
            error.blocker.code === 'stale_base' ? 409 : 503,
            error.blocker.code,
            'Wiki history is unavailable',
          );
        return wikiError(error);
      }
    },
  );
}
