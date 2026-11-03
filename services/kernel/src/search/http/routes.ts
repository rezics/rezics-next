import { createTrendingSearchesService } from '../trending-searches.ts';
import { requiresAdvancedDiscoverySearch } from '../discovery-request.ts';
import type { DiscoverySearch } from '../discovery-service.ts';
import { DiscoveryPageSchema, discoveryHttpPage, type DiscoveryHttpPage } from '../discovery-http.ts';
import { chooseLabel } from '../../semantic/language.ts';
import { compileKinds } from '../query.ts';
import { readSubjectSummaries, summaryAuthorization, type SubjectSummary } from '../../semantic/summaries.ts';
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
import { createSearchService, requiresAdvancedSearch, type PublicSearchPage } from '../service.ts';
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
type SearchHttpBase = Static<typeof genericBase>;
type SearchHttpResponse = Omit<PublicSearchPage, 'subjects'> & {
  subjects: (PublicSearchPage['subjects'][number] & {
    summary: SubjectSummary | null;
    kind: string;
    base: SearchHttpBase;
  })[];
};
const facetResponse = t.Object(
  {
    facets: t.Array(
      t.Object(
        {
          property: t.String(),
          next: t.Union([t.String(), t.Null()]),
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
    discovery,
    access,
    gateAccess,
    clock = systemClock,
  }: {
    pool: Pool;
    routeKey: Uint8Array;
    search?: SearchService;
    discovery?: DiscoverySearch;
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
            authorize: summaryAuthorization(async (id, batch) => {
              const route = routeOf(id)!;
              return authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
            }),
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

  const trending = createTrendingSearchesService({ pool, clock });
  const routed = (app as ReturnType<typeof createApp>)
    .model('PublicFigure', PublicFigureSchema)
    .get(
      '/v1/trendingSearches',
      {
        query: t.Object(
          {
            language: t.String({ minLength: 2, maxLength: 35 }),
            limit: t.Optional(t.IntegerString({ minimum: 1, maximum: 10 })),
          },
          object,
        ),
        response: {
          200: t.Object(
            {
              trendingSearches: t.Array(t.Object({ query: t.String(), display: t.String() }, object), { maxItems: 10 }),
              next: t.Null(),
            },
            object,
          ),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          503: problemSchema('semantic_not_ready', 'index_not_ready', 'overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'trending_searches.list',
          'x-exposure': 'gate:search',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ query, authorize, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
          const outcome = await trending.read(query.language, query.limit);
          if (outcome.status !== 'ready')
            throw new ProblemError('semantic_not_ready', {
              headers: { 'retry-after': '1', 'cache-control': 'private, no-store' },
            });
          return outcome.page;
        });
      },
    )
    .post(
      customMethod('/v1/subjects', 'search'),
      {
        body: t.Object(
          {
            representation: t.Optional(t.Literal('discovery-v1')),
            kindPage: t.Optional(
              t.Object(
                {
                  limit: t.Integer({ minimum: 1, maximum: 8 }),
                  cursor: t.Optional(t.String({ maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength })),
                },
                object,
              ),
            ),
            kindCountLeaf: t.Optional(t.Integer({ minimum: 0 })),
            text: t.Optional(t.String()),
            filter: t.Optional(t.Any()),
            population: t.Optional(t.Object({ realm: t.String({ format: 'uuid' }) }, object)),
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
          200: t.Union([searchResponse, DiscoveryPageSchema]),
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
      ({ body, authorize, admission, job, actor, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        if (body.representation === 'discovery-v1' && body.population !== undefined)
          throw new ProblemError('unsupported_query', { errors: [{ pointer: '/population', code: 'unsupported' }] });
        async function prepare(): Promise<AccessCheck> {
          if (
            body.representation === 'discovery-v1'
              ? requiresAdvancedDiscoverySearch({ ...body, representation: 'discovery-v1' })
              : requiresAdvancedSearch(body)
          )
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
          return authorize({
            ...resource,
            ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
          });
        }
        async function mixed(): Promise<DiscoveryHttpPage> {
          const check = await prepare();
          return admission.run('normal', job, async () => {
            if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
            if (!discovery) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            const ownerAccess: Access | undefined =
              gateAccess?.() ?? (typeof access === 'function' ? access({ actions: actionCatalogue(routed) }) : access);
            if (!ownerAccess) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            return discoveryHttpPage(
              await discovery(
                actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
                { ...body, representation: 'discovery-v1' },
                { access: ownerAccess, actor, deadline: job.deadline },
              ),
            );
          });
        }
        async function catalogue(): Promise<SearchHttpResponse> {
          const check = await prepare();
          return admission.run('normal', job, async () => {
            if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
            if (body.kindPage !== undefined || body.kindCountLeaf !== undefined)
              throw new ProblemError('invalid_request', {
                errors: [{ pointer: '/representation', code: 'invalid_format' }],
              });
            if (!search) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            const active = await activeRelease(pool);
            let completed: SearchHttpResponse | undefined;
            await search.search(
              actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
              body,
              clock().getTime(),
              active,
              {
                deadline: job.deadline,
                async complete(page) {
                  completed = publicBases(
                    await fill(page, authorize, body.languages, active),
                    body.languages ?? [],
                    active,
                  );
                },
              },
            );
            if (!completed) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            await trending.submitted(actor, body);
            return completed;
          });
        }
        return body.representation === 'discovery-v1' ? mixed() : catalogue();
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
                  cursor: t.Optional(t.String({ maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength })),
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
          409: problemSchema('search_restart_required'),
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
            { deadline: job.deadline },
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
          let completed: Static<typeof suggestResponse> | undefined;
          await search.suggest(query.q, query.limit, query.languages, {
            deadline: job.deadline,
            async complete(page) {
              completed = await fill(page, authorize, query.languages);
            },
          });
          if (!completed) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          return completed;
        });
      },
    );
  return routed as typeof routed & App;
}
