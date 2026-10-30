import { chooseLabel } from '../../semantic/language.ts';
import { compileKinds } from '../query.ts';
import { readSubjectSummaries, type SubjectSummary } from '../../semantic/summaries.ts';
import { CoverSummarySchema, SubjectSummarySchema } from '../../semantic/http/summaries.ts';
import { activeRelease } from '../../semantic/definitions.ts';
import { relatedReadEligibility } from '../../semantic/eligibility.ts';
import { routeOf } from '../../route/route.ts';
import type { Resource, AccessCheck } from '../../request/access.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import type { createApp } from '../../http/app.ts';
import { actionCatalogue } from '../../http/request.ts';
import type { Access, AccessFactory } from '../../request/access.ts';
import { GLOBAL_CONTEXT } from '../../semantic/definitions.ts';
import { globalReadEligibility } from '../../semantic/eligibility.ts';
import { admitGroup } from '../../access/gates/admission.ts';
import { createSearchService, requiresAdvancedSearch } from '../service.ts';
import { LIST_CURSOR_BOUNDS } from '../../tokens/list-cursor.ts';
import { systemClock, type KernelClock } from '../../clock.ts';
import { PublicFigureSchema } from '../../rating/public-figure-http.ts';

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
export const FactSchema = t.Union([
  t.Object(
    { kind: t.Literal('item'), id: t.String({ format: 'uuid' }), labels: t.Record(t.String(), t.String()) },
    object,
  ),
  t.Object({ kind: t.Literal('time'), year: t.Integer() }, object),
  t.Object({ kind: t.Literal('quantity'), amount: t.Number(), unit: t.String() }, object),
  t.Object({ kind: t.Literal('code'), value: t.String() }, object),
]);
const publicLabel = t.Object({ value: t.String(), language: t.String() }, object);
const nullableLabel = t.Union([publicLabel, t.Null()]);
const publicImage = t.Union([
  t.Object(
    {
      ...CoverSummarySchema.anyOf[0].properties,
      aspect: t.Object({ width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }) }, object),
    },
    object,
  ),
  t.Null(),
]);
const genericBase = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    kind: t.String(),
    kindLabel: publicLabel,
    title: nullableLabel,
    image: publicImage,
    url: t.Object({ id: t.String({ format: 'uuid' }), label: nullableLabel }, object),
  },
  object,
);
const kindPage = t.Object(
  {
    values: t.Array(
      t.Object(
        {
          value: t.String(),
          label: publicLabel,
          icon: t.Union([t.String(), t.Null()]),
          count: t.Optional(t.Object({ value: t.Integer({ minimum: 1 }), exact: t.Boolean() }, object)),
        },
        object,
      ),
      { maxItems: 8 },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  object,
);
const searchHit = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    type: t.String(),
    kind: t.String(),
    base: genericBase,
    labels: t.Record(t.String(), t.String()),
    summary: t.Union([SubjectSummarySchema, t.Null()]),
    descriptions: t.Optional(t.Record(t.String(), t.String())),
    facts: t.Optional(t.Record(t.String(), t.Array(FactSchema))),
    figure: t.Ref('PublicFigure'),
  },
  object,
);
const searchResponse = t.Object(
  {
    subjects: t.Array(searchHit),
    kinds: t.Optional(kindPage),
    next: t.Union([t.String(), t.Null()]),
    as_of: t.String({ format: 'date-time' }),
  },
  object,
);
type SearchHttpResponse = Static<typeof searchResponse>;
type SearchHttpBase = Static<typeof genericBase>;
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
  {
    pool,
    routeKey,
    search,
    access,
    gateAccess,
    clock = systemClock,
  }: {
    pool: Pool;
    routeKey: Uint8Array;
    search?: SearchService;
    access?: Access | AccessFactory;
    gateAccess?: () => Access;
    clock?: KernelClock;
  },
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  async function fill<T extends { subjects: { id: string; type: string; labels: Record<string, string> }[] }>(
    page: T,
    authorize: (resource: Resource) => Promise<AccessCheck>,
    languages: readonly string[] = [],
    active: Awaited<ReturnType<typeof activeRelease>> | undefined = undefined,
  ): Promise<Omit<T, 'subjects'> & { subjects: (T['subjects'][number] & { summary: SubjectSummary | null })[] }> {
    active = active === undefined ? await activeRelease(pool) : active;
    const summaries = active
      ? await readSubjectSummaries(
          {
            client: { query: pool.query.bind(pool) },
            pool,
            routeKey,
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
  function publicBases<
    T extends {
      subjects: { id: string; type: string; labels: Record<string, string>; summary: SubjectSummary | null }[];
    },
  >(
    page: T,
    languages: readonly string[],
    active: Awaited<ReturnType<typeof activeRelease>>,
  ): Omit<T, 'subjects'> & {
    subjects: (T['subjects'][number] & { kind: string; base: SearchHttpBase })[];
  } {
    return {
      ...page,
      subjects: page.subjects.map((subject) => {
        const title = subject.summary?.label ?? chooseLabel(subject.labels, languages) ?? null;
        return {
          ...subject,
          kind: subject.type,
          base: {
            id: subject.id,
            kind: subject.type,
            kindLabel: active
              ? compileKinds(active.release, active.digest).label(subject.type, languages)
              : { value: subject.type, language: 'und' },
            title,
            image: subject.summary?.cover
              ? {
                  ...subject.summary.cover,
                  aspect: { width: subject.summary.cover.width, height: subject.summary.cover.height },
                }
              : null,
            url: { id: subject.id, label: title },
          },
        };
      }),
    };
  }

  const routed = (app as ReturnType<typeof createApp>)
    .model('PublicFigure', PublicFigureSchema)
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
            cursor: t.Optional(t.String({ maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength })),
            kindCursor: t.Optional(t.String({ maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength })),
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
          'x-exposure': 'gate:search',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ body, authorize, admission, job, actor }) => {
        if (requiresAdvancedSearch(body))
          await admitGroup({
            pool,
            access:
              gateAccess ??
              (() => (typeof access === 'function' ? access({ actions: actionCatalogue(routed) }) : access!)),
            actor,
            group: 'search_advanced',
            clientAction: 'subject:read',
            deadline: job.deadline,
            clock,
          });
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
          if (!search) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          const active = await activeRelease(pool);
          const page = await fill(
            await search.search(
              actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
              body,
              clock().getTime(),
              active,
            ),
            authorize,
            body.languages,
            active,
          );
          return publicBases(page, body.languages ?? [], active) satisfies SearchHttpResponse;
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
          'x-exposure': 'gate:search_advanced',
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
          return search.facets(
            actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
            body,
            clock().getTime(),
          );
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
          'x-exposure': 'gate:search',
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
