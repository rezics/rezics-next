import { TextDiagnosticSchema } from './text-diagnostic.ts';
export { FactSchema } from './catalogue.ts';
import { FILTER_LIMITS } from '@rezics/filter';
import { createCatalogueResponseAdapter, searchResponse, type SearchHttpResponse } from './catalogue.ts';
import { releaseGroupsResponse, releaseChildrenResponse, releaseResponse } from './releases.ts';
import { facetResponse } from './facets.ts';
import { suggestResponse } from './suggest.ts';
import { prepareQueryShare, unavailableQueryShare } from '../query-share.ts';
import { QueryShareSchema } from './query-share-schemas.ts';
import { createTrendingSearchesService } from '../trending-searches.ts';
import { requiresAdvancedDiscoverySearch } from '../discovery-request.ts';
import type { DiscoverySearch } from '../discovery-service.ts';
import { DiscoveryPageSchema, discoveryHttpPage, type DiscoveryHttpPage } from '../discovery-http.ts';
import { createNativeSuggestionWorkContextReader } from '../suggestion-context-native.ts';
import { activeRelease } from '../../semantic/definitions.ts';
import type { AccessCheck } from '../../request/access.ts';
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
import { createSearchService, requiresAdvancedSearch, type GroupedReleaseSearchRequest } from '../service.ts';
import { LIST_CURSOR_BOUNDS } from '../../tokens/list-cursor.ts';
import { systemClock, type KernelClock } from '../../clock.ts';
import { PublicFigureSchema } from '../../rating/public-figure-http.ts';
import { readEmptyRecovery, type EmptyRecoveryAction, type EmptyRecoveryCandidate } from '../empty-recovery.ts';
import { EmptyRecoveryActionsSchema, EmptyRecoverySchema } from './empty-recovery-schemas.ts';

type SearchServiceImplementation = ReturnType<typeof createSearchService>;
export type SearchService = Omit<SearchServiceImplementation, 'releaseGroups'> & {
  releaseGroups?: SearchServiceImplementation['releaseGroups'];
};

const object = { additionalProperties: false } as const;
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
  let actionCatalogueApp: Parameters<typeof actionCatalogue>[0] | undefined;
  const routeAccess = (): Access | undefined => {
    if (gateAccess) return gateAccess();
    if (typeof access !== 'function') return access;
    if (!actionCatalogueApp) throw new Error('Search route action catalogue is not mounted');
    return access({ actions: actionCatalogue(actionCatalogueApp) });
  };
  const catalogueResponses = createCatalogueResponseAdapter({ pool, routeKey });
  const { fill, publicBases } = catalogueResponses;

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
            prepareShare: t.Optional(t.Boolean()),
            representation: t.Optional(t.Union([t.Literal('discovery-v1'), t.Literal('release-groups-v1')])),
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
            spoilerThreshold: t.Optional(t.Integer({ minimum: 0, maximum: 2 })),
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
            work: t.Optional(t.String({ format: 'uuid' })),
            childCursor: t.Optional(t.String({ maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength })),
            kindCursor: t.Optional(t.String({ maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength })),
            descriptions: t.Optional(t.Boolean()),
            languages: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 8 })),
            properties: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 4 })),
            emptyRecoveryActions: EmptyRecoveryActionsSchema,
          },
          object,
        ),
        response: {
          200: t.Union([
            searchResponse,
            DiscoveryPageSchema,
            releaseGroupsResponse,
            releaseChildrenResponse,
            QueryShareSchema,
          ]),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('search_restart_required'),
          422: problemSchema('unsupported_query', { textDiagnostic: t.Optional(TextDiagnosticSchema) }),
          503: problemSchema('semantic_not_ready', 'index_not_ready', 'overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.search',
          'x-exposure': 'gate:search',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ body, authorize, admission, job, actor, set }) => {
        const { emptyRecoveryActions: _emptyRecoveryActions, ...nativeBody } = body;
        if (body.population !== undefined || body.representation === 'discovery-v1')
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
              access: gateAccess ?? (() => routeAccess()!),
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
        async function recoveryForPage(
          page: { count: number; next: string | null; as_of: string },
          scope: NonNullable<Parameters<SearchService['search']>[4]>['scope'],
          active?: Awaited<ReturnType<typeof activeRelease>>,
        ): Promise<Static<typeof EmptyRecoverySchema> | undefined> {
          if (
            page.count !== 0 ||
            page.next !== null ||
            body.cursor !== undefined ||
            body.kindCursor !== undefined ||
            !body.text?.trim()
          )
            return undefined;
          const actions: EmptyRecoveryAction[] = [
            { kind: 'edit-query' },
            ...(body.emptyRecoveryActions ?? []).filter((action) => action.kind !== 'edit-query'),
          ].slice(0, 8) as EmptyRecoveryAction[];
          return readEmptyRecovery({
            query: body.text,
            asOf: page.as_of,
            actions,
            failureStatus: (error) =>
              error instanceof ProblemError && (error.code === 'index_not_ready' || error.code === 'semantic_not_ready')
                ? 'preparing'
                : 'unavailable',
            async read(prefix, limit) {
              // Realm populations do not have an installed suggestion adapter; never suggest from Global.
              if (body.population !== undefined || !search)
                throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
              let completed: { asOf: string; candidates: EmptyRecoveryCandidate[] } | undefined;
              await search.suggest(prefix, limit, body.languages, {
                deadline: job.deadline,
                ...(body.filter === undefined ? {} : { filter: body.filter }),
                ...(scope ? { scope } : {}),
                async complete(suggestions) {
                  const current = await fill(suggestions, authorize, body.languages ?? [], active);
                  completed = {
                    asOf: current.as_of,
                    candidates: current.subjects.flatMap((subject) => {
                      const label = subject.summary?.label;
                      return label?.value.trim() ? [{ id: subject.id, label: label.value }] : [];
                    }),
                  };
                },
              });
              if (!completed) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
              return completed;
            },
          });
        }
        async function mixed(): Promise<DiscoveryHttpPage> {
          set.headers['cache-control'] = 'private, no-store';
          const check = await prepare();
          return admission.run('normal', job, async () => {
            if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
            if (!discovery) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            const ownerAccess: Access | undefined = routeAccess();
            if (!ownerAccess) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            const observeRelationRelease = async () => {
              const active = await activeRelease(pool);
              return active
                ? {
                    digest: active.digest,
                    head: active.head ?? 0,
                    release: active.release as import('@rezics/filter').FilterRelease,
                    definitions: active.release,
                  }
                : null;
            };
            const page = discoveryHttpPage(
              await discovery(
                actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
                { ...nativeBody, representation: 'discovery-v1' },
                {
                  access: ownerAccess,
                  actor,
                  deadline: job.deadline,
                  ...(body.languages === undefined ? {} : { languages: body.languages }),
                  descriptions: body.descriptions === true,
                  ...(body.spoilerThreshold === undefined
                    ? {}
                    : { spoilerThreshold: body.spoilerThreshold as 0 | 1 | 2 }),
                  observeRelationRelease,
                },
              ),
            );
            const emptyRecovery = await recoveryForPage(
              { count: page.hits.length, next: page.next, as_of: page.as_of },
              ownerAccess ? { access: ownerAccess, actor, deadline: job.deadline, routeKey } : undefined,
            );
            return emptyRecovery ? { ...page, emptyRecovery } : page;
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
            const realmAccess = body.population ? routeAccess() : undefined;
            if (body.population && !realmAccess)
              throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            const active = await activeRelease(pool);
            const scopeAccess: Access | undefined = realmAccess ?? routeAccess();
            const scopeOptions = scopeAccess
              ? { access: scopeAccess, actor, deadline: job.deadline, routeKey }
              : undefined;
            let completed: SearchHttpResponse | undefined;
            await search.search(
              actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
              nativeBody,
              clock().getTime(),
              active,
              {
                deadline: job.deadline,
                ...(scopeOptions ? { scope: scopeOptions } : {}),
                ...(realmAccess ? { realmAuthority: { access: realmAccess, actor } } : {}),
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
            const emptyRecovery = await recoveryForPage(
              { count: completed.subjects.length, next: completed.next, as_of: completed.as_of },
              scopeOptions,
              active,
            );
            await trending.submitted(actor, nativeBody);
            return emptyRecovery ? { ...completed, emptyRecovery } : completed;
          });
        }
        async function grouped() {
          const check = await prepare();
          return admission.run('normal', job, async () => {
            set.headers['cache-control'] = 'private, no-store';
            if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
            if (!search?.releaseGroups) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            if (
              body.population !== undefined ||
              body.kindPage !== undefined ||
              body.kindCountLeaf !== undefined ||
              body.kindCursor !== undefined
            )
              throw new ProblemError('unsupported_query', {
                errors: [{ pointer: '/representation', code: 'unsupported' }],
              });
            const active = await activeRelease(pool);
            const principal: 'anonymous' | `account:${string}` =
              actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous';
            const page = await search.releaseGroups(
              principal,
              nativeBody as GroupedReleaseSearchRequest,
              clock().getTime(),
              active,
              { deadline: job.deadline, complete: async () => {} },
            );
            await trending.submitted(actor, body);
            return releaseResponse(page, catalogueResponses, authorize, body.languages ?? [], active);
          });
        }
        if (body.prepareShare) {
          set.headers['cache-control'] = 'private, no-store';
          // Reuse exactly the mounted execution and grants. The link itself grants nothing.
          if (body.representation === 'discovery-v1') await mixed();
          else if (body.representation === 'release-groups-v1') await grouped();
          else await catalogue();
          const active = await activeRelease(pool);
          const labels: Record<string, Record<string, string>> = {};
          if (active) {
            for (const [id, definition] of Object.entries(active.release.types)) labels[id] = definition.labels;
            for (const [id, definition] of Object.entries(active.release.properties)) labels[id] = definition.labels;
          }
          const projection =
            body.representation === 'discovery-v1'
              ? prepareQueryShare(body, labels)
              : unavailableQueryShare('unsupported');
          projection.viewer = actor.kind === 'account' ? 'signed-in' : 'anonymous';
          return projection;
        }
        if (body.representation === 'discovery-v1') return mixed();
        if (body.representation === 'release-groups-v1') return grouped();
        return catalogue();
      },
    )
    .post(
      customMethod('/v1/subjects', 'facets'),
      {
        body: t.Object(
          {
            text: t.Optional(t.String()),
            filter: t.Optional(t.Any()),
            conditions: t.Optional(t.Any()),
            kinds: t.Optional(
              t.Array(t.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: FILTER_LIMITS.in }),
            ),
            languages: t.Optional(t.Array(t.String(), { minItems: 1, maxItems: 8 })),
            scope: t.Optional(
              t.Object(
                { kind: t.Union([t.Literal('realm'), t.Literal('collection')]), id: t.String({ format: 'uuid' }) },
                object,
              ),
            ),
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
          422: problemSchema('unsupported_query', { textDiagnostic: t.Optional(TextDiagnosticSchema) }),
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
          const scopeAccess = routeAccess();
          return search.facets(
            actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous',
            body,
            clock().getTime(),
            {
              deadline: job.deadline,
              ...(scopeAccess ? { scope: { access: scopeAccess, actor, deadline: job.deadline, routeKey } } : {}),
            },
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
            filter: t.Optional(t.String()),
          },
          object,
        ),
        response: {
          200: suggestResponse,
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          409: problemSchema('search_restart_required'),
          422: problemSchema('unsupported_query', { textDiagnostic: t.Optional(TextDiagnosticSchema) }),
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
      async ({ query, authorize, admission, job, actor, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        if (query.limit !== undefined && (query.limit < 1 || query.limit > 10))
          throw new ProblemError('invalid_request', { errors: [{ pointer: '/limit', code: 'out_of_range' }] });
        let filter: unknown;
        if (query.filter !== undefined) {
          try {
            filter = JSON.parse(query.filter);
          } catch {
            throw new ProblemError('invalid_request', { errors: [{ pointer: '/filter', code: 'invalid_format' }] });
          }
        }
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('subject:read') } : {}),
        });
        return admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
          if (!search) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          const scopeAccess = routeAccess();
          const suggestionWorkContext = scopeAccess
            ? createNativeSuggestionWorkContextReader({ pool, access: scopeAccess, actor, routeKey })
            : undefined;
          let completed: Static<typeof suggestResponse> | undefined;
          await search.suggest(query.q, query.limit, query.languages, {
            deadline: job.deadline,
            ...(filter === undefined ? {} : { filter }),
            ...(scopeAccess ? { scope: { access: scopeAccess, actor, deadline: job.deadline, routeKey } } : {}),
            ...(suggestionWorkContext ? { suggestionWorkContext } : {}),
            async complete(page) {
              completed = await fill(page, authorize, query.languages);
            },
          });
          if (!completed) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          return completed;
        });
      },
    );
  actionCatalogueApp = routed as Parameters<typeof actionCatalogue>[0];
  return routed as typeof routed & App;
}
