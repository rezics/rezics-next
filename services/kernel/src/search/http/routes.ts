import { readSubjectSummaries, type SubjectSummary } from '../../semantic/summaries.ts';
import { SubjectSummarySchema } from '../../semantic/http/summaries.ts';
import { activeRelease } from '../../semantic/definitions.ts';
import { relatedReadEligibility } from '../../semantic/eligibility.ts';
import { routeOf } from '../../route/route.ts';
import type { Resource, AccessCheck } from '../../request/access.ts';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import type { createApp } from '../../http/app.ts';
import type { Access, AccessFactory } from '../../request/access.ts';
import { GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import { createSearchService } from '../service.ts';

export type SearchService = ReturnType<typeof createSearchService>;

const object = { additionalProperties: false } as const;
const result = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    type: t.String(),
    labels: t.Record(t.String(), t.String()),
    summary: t.Union([SubjectSummarySchema, t.Null()]),
  },
  object,
);
const fact = t.Union([
  t.Object(
    { kind: t.Literal('item'), id: t.String({ format: 'uuid' }), labels: t.Record(t.String(), t.String()) },
    object,
  ),
  t.Object({ kind: t.Literal('time'), year: t.Integer() }, object),
  t.Object({ kind: t.Literal('quantity'), amount: t.Number(), unit: t.String() }, object),
  t.Object({ kind: t.Literal('code'), value: t.String() }, object),
]);
const searchHit = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    type: t.String(),
    labels: t.Record(t.String(), t.String()),
    summary: t.Union([SubjectSummarySchema, t.Null()]),
    descriptions: t.Optional(t.Record(t.String(), t.String())),
    facts: t.Optional(t.Record(t.String(), t.Array(fact))),
  },
  object,
);
const searchResponse = t.Object(
  {
    subjects: t.Array(searchHit),
    next: t.Union([t.String(), t.Null()]),
    as_of: t.String({ format: 'date-time' }),
  },
  object,
);
const facetResponse = t.Object(
  {
    facets: t.Array(
      t.Object(
        {
          property: t.String(),
          values: t.Array(
            t.Object(
              {
                value: t.String(),
                labels: t.Record(t.String(), t.String()),
              },
              object,
            ),
          ),
        },
        object,
      ),
    ),
    as_of: t.String({ format: 'date-time' }),
  },
  object,
);
const suggestResponse = t.Object({ subjects: t.Array(result), as_of: t.String({ format: 'date-time' }) }, object);
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const unavailable = problemSchema('index_not_ready', 'overloaded', 'deadline_exceeded');
const resource = { route: 0, id: GLOBAL_CONTEXT };

export function searchRoutes<App>(
  app: App,
  { pool, search, access }: { pool: Pool; search?: SearchService; access?: Access | AccessFactory },
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  async function fill<T extends { subjects: { id: string; type: string; labels: Record<string, string> }[] }>(
    page: T,
    authorize: (resource: Resource) => Promise<AccessCheck>,
    languages: readonly string[] = [],
  ): Promise<Omit<T, 'subjects'> & { subjects: (T['subjects'][number] & { summary: SubjectSummary | null })[] }> {
    const active = await activeRelease(pool);
    const summaries = active
      ? await readSubjectSummaries(
          {
            client: { query: pool.query.bind(pool) },
            pool,
            release: active.release,
            async authorize(connection, id, batch) {
              const route = routeOf(id);
              if (route === null) return false;
              const check = await authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
              return check(connection);
            },
          },
          page.subjects.map((subject) => subject.id),
          { languages },
        )
      : new Map();
    return {
      ...page,
      subjects: page.subjects.map((subject) => ({ ...subject, summary: summaries.get(subject.id) ?? null })),
    };
  }
  const routed = (app as ReturnType<typeof createApp>)
    .post(
      customMethod('/v1/subjects', 'search'),
      {
        body: t.Object(
          {
            text: t.Optional(t.String()),
            filter: t.Optional(t.Any()),
            sort: t.Optional(
              t.Union([
                t.Literal('relevance'),
                t.Literal('name'),
                t.Literal('id'),
                t.Literal('collections'),
                t.Literal('rating'),
              ]),
            ),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
            cursor: t.Optional(t.String()),
            descriptions: t.Optional(t.Boolean()),
            languages: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 8 })),
            properties: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 4 })),
          },
          object,
        ),
        response: {
          200: searchResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('search_restart_required'),
          422: problemSchema('unsupported_query'),
          503: problemSchema('semantic_not_ready', 'index_not_ready', 'overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.search',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ body, authorize, admission, job, actor }) => {
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
          if (!search) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          return fill(
            await search.search(actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous', body),
            authorize,
            body.languages,
          );
        });
      },
    )
    .post(
      customMethod('/v1/subjects', 'facets'),
      {
        body: t.Object(
          {
            text: t.Optional(t.String()),
            filter: t.Optional(t.Any()),
            languages: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 8 })),
            facets: t.Array(
              t.Object(
                {
                  property: t.String(),
                  size: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
                },
                object,
              ),
              { minItems: 1, maxItems: 8 },
            ),
          },
          object,
        ),
        response: {
          200: facetResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('unsupported_query'),
          503: problemSchema('semantic_not_ready', 'index_not_ready', 'overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.facets',
          description:
            'Optional languages selects one label per facet value in preference order. Omit it to return all labels.',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ body, authorize, admission, job, actor }) => {
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
          if (!search) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          return search.facets(actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous', body);
        });
      },
    )
    .get(
      customMethod('/v1/subjects', 'suggest'),
      {
        query: t.Object(
          {
            q: t.String(),
            limit: t.Optional(t.IntegerString()),
            languages: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 8 })),
          },
          object,
        ),
        response: {
          200: suggestResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          503: unavailable,
        },
        detail: {
          operationId: 'subject.suggest',
          description:
            'Repeat languages in preference order to select one label per suggestion. Omit it to return all labels.',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ query, authorize, admission, job }) => {
        if (query.limit !== undefined && (query.limit < 1 || query.limit > 10))
          throw new ProblemError('invalid_request', { errors: [{ pointer: '/limit', code: 'out_of_range' }] });
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
          if (!search) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          return fill(await search.suggest(query.q, query.limit, query.languages), authorize, query.languages);
        });
      },
    );
  return routed as typeof routed & App;
}
