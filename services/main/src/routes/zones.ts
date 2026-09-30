import { Elysia, t } from 'elysia';
import { readingPositionQuery } from './reading-positions.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { bootstrapAdmittedStructureOwner } from '../modules/structure/bootstrap.ts';
import { changeAdmittedComposition } from '../modules/structure/change-admitted.ts';
import { CompositionConflict, InvalidCompositionChange, StaleCompositionHead }
  from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readVisibleCompositionPage } from '../modules/collection/visible-page.ts';
import { resolveZoneRoute, readZonePresentation, zoneRouteViewer, ZoneRouteMissing, ZONE_ROUTE_COST }
  from '../modules/zone/route.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadUnavailable, WorkReadLimit }
  from '../modules/work/read-session.ts';
import { readName, workCard, readPosition } from '../modules/work/read-contract.ts';
import { canReadStructureTarget, structureProfileFor } from '../modules/structure/profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { createAdmittedOwner } from '../modules/zone/owner-create.ts';
import { ZoneName, readZoneName } from '../modules/zone/read-name.ts';
import { languageTag } from '../modules/display-language/schema.ts';
import { changeZoneConfiguration, readZoneConfiguration,
  ZoneOfficialDenied, ZoneStale, ZoneUnavailable } from '../modules/zone/configuration.ts';
import { InvalidZoneConfiguration } from '../modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, ZonePresentation, zoneRenderTokens }
  from '../modules/zone/presentation-format.ts';
import { listOfficialZones, officialZoneBySegment, readZoneModuleData,
  readZoneBannerMedia }
  from '../modules/zone/publication.ts';
import { zonePackageExecution, readFirstPartyTheme }
  from '../modules/theme/first-party-lifecycle.ts';
import { FirstPartyBundle } from '../modules/theme/first-party-bundle.ts';
import { runZoneQueryBlocks, ZoneQueryBudgetExceeded } from '../modules/zone/query-budget.ts';
import { readDynamicDefinition, executeDynamicDefinition, DynamicCollectionUnavailable }
  from '../modules/collection/dynamic.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable }
  from '../modules/work/search-public.ts';
import { MAX_SEARCH_REQUEST_MS, SearchIndexUnavailable, withStableSearchSnapshot }
  from '../modules/work/search-readiness.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { GRAPHS, hash, iri } from '../modules/work/activate.ts';
import { problemResult, pendingOperation } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const disclosure = t.Union([t.Literal('public'), t.Literal('private')]);
const sourcePosition = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const cost = t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(),
  placementsWritten: t.Integer(), segmentsWritten: t.Integer(), rebalanced: t.Integer() });
const write = t.Object({ zone: ref, navigation: ref, revision: ref, receipt: t.String(),
  replayed: t.Boolean(), occurrences: t.Optional(t.Array(ref)), cost: t.Optional(cost),
  sourcePosition: t.Optional(sourcePosition) });
const read = t.Object({ zone: ref, navigation: ref, revision: ref,
  ownerRevision: ref, ...ZoneName.properties,
  predecessor: t.Nullable(ref), mounts: t.Array(t.Any()), next: t.Nullable(t.String()),
  sourcePosition });
const errors = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
  503: problemResult(503) };

export const openApiOperations = {
  '/v1/zones': { post: { bearer: true, idempotencyKey: true }, get: {} },
  '/v1/zones/by-segment/{segment}': { get: {} },
  '/v1/zones/{id}/presentation': { get: {} },
  '/v1/zones/{id}/routes': { get: {} },
  '/v1/zones/{id}/mounts': { post: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}/mounts/{occurrence}': { delete: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}': { get: { bearer: true } },
  '/v1/zones/{id}/revisions/{revision}': { get: { bearer: true } },
  '/v1/zones/{id}/configuration': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}/query-blocks': { get: { bearer: true } },
  '/v1/zones/{id}/retirements': { post: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}/recoveries': { post: { bearer: true, idempotencyKey: true } },
} as const;

function key(request: Request) {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function routeError(error: unknown): Response {
  if (error instanceof ZoneRouteMissing) return problem(404, 'route_missing', 'Zone route is unavailable');
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_zone_cursor', error.message);
  if (error instanceof WorkReadMoved) return problem(409, 'zone_route_stale', error.message);
  if (error instanceof WorkReadUnavailable || error instanceof WorkReadLimit) {
    return problem(503, 'zone_route_unavailable', 'Zone route is unavailable');
  }
  if (error instanceof InvalidZoneConfiguration) return problem(400, 'invalid_zone_configuration', error.message);
  if (error instanceof ZoneOfficialDenied) return problem(403, 'official_zone_denied', error.message);
  if (error instanceof ZoneQueryBudgetExceeded) return problem(503, 'zone_query_budget', error.message);
  if (error instanceof PublicQueryBudgetExceeded) return problem(503, 'zone_query_budget',
    'Zone query exceeds its candidate budget');
  if (error instanceof PublicQueryUnavailable || error instanceof SearchIndexUnavailable) {
    return problem(503, 'zone_query_unavailable', 'Zone query is unavailable');
  }
  if (error instanceof DynamicCollectionUnavailable) return problem(404, 'zone_query_unavailable',
    'Zone query definition is unavailable');
  if (error instanceof ZoneStale) return problem(409, 'stale_zone_head', error.message);
  if (error instanceof ZoneUnavailable) return problem(404, 'zone_unavailable', 'Zone is unavailable');
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_zone_change', error.message);
  if (error instanceof CompositionConflict) return problem(409, 'zone_route_conflict', error.message);
  if (error instanceof StaleCompositionHead) {
    return problem(409, 'zone_conflict', error.message);
  }
  if (error instanceof CompositionUnavailable) return problem(404, 'zone_unavailable', 'Zone is unavailable');
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) {
    return problem(503, 'zone_unavailable', 'Zone history is unavailable');
  }
  return commandError(error);
}

const queryBlock = t.Object({ block: t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
  definition: ref, parent: t.Optional(t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 })),
  maxRows: t.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false });
const configRead = t.Object({ zone: ref, revision: ref, configuration: t.Any(),
  ...ZoneName.properties,
  cost: t.Object({ graphReads: t.Integer(), objectReads: t.Integer() }) });
const revisionWrite = t.Object({ zone: ref, revision: ref, receipt: t.String(),
  replayed: t.Boolean(), sourcePosition });
const officialZone = t.Object({ zone: ref, realm: ref, routeSegment: t.String() });
const officialPage = t.Object({ items: t.Array(officialZone), next: t.Nullable(t.String()),
  cost: t.Object({ graphReads: t.Integer(), rows: t.Integer() }) });
const officialLookup = t.Object({ ...officialZone.properties,
  cost: t.Object({ graphReads: t.Integer(), rows: t.Integer() }) });
const execution = t.Union([
  t.Object({ state: t.Literal('fallback'), reason: t.Union([
    t.Literal('safe_mode'), t.Literal('viewer_opt_out'), t.Literal('none_approved'),
    t.Literal('globally_disabled'), t.Literal('revoked'), t.Literal('expired')]) }),
  t.Object({ state: t.Literal('active'), package: FirstPartyBundle,
    revision: ref, activation: ref }),
  t.Object({ state: t.Literal('package'), packageDigest: t.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
    revision: ref, activation: ref }),
]);
const publicationRead = t.Object({ profile: t.Literal('zone-presentation-response-v1'),
  ...ZoneName.properties,
  zone: ref, realm: t.Nullable(ref), official: t.Nullable(t.String()), revision: ref,
  presentation: ZonePresentation,
  bannerMedia: t.Array(t.Object({ id: t.String(), image: t.Nullable(t.Object({
    url: t.String(), width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }),
    mediaType: t.String() })) }), { maxItems: 6 }),
  moduleData: t.Array(t.Any()),
  navigation: t.Array(t.Object({ occurrence: ref, segment: t.String(), target: ref,
    kind: t.Union([t.Literal('document'), t.Literal('index')]), name: readName }), { maxItems: 50 }),
  renderTokens: t.Object({ ...ZonePresentation.properties.tokens.properties,
    textOnAccent: t.String({ pattern: '^#[0-9a-f]{6}$' }) }),
  execution,
  cost: t.Object({ graphReads: t.Integer(), objectReads: t.Integer(),
    officialPageSize: t.Integer(), maxModules: t.Integer(), maxBanners: t.Integer(),
    maxBannerMediaReads: t.Integer(),
    maxResolvedBlocks: t.Integer(), maxResolvedCollections: t.Integer(),
    maxCollectionPlacements: t.Integer(), maxModuleGraphReads: t.Integer(),
    maxNavigation: t.Integer(), maxNavigationGraphReads: t.Integer() }),
});

const mountBinding = t.Object({ occurrence: ref, segment: t.String(), target: ref });
const resourceBinding = t.Object({ id: ref, types: t.Array(t.String(), { maxItems: 8 }) });
const routeBasis = { profile: t.Literal('zone-route-v1'), zone: ref, path: t.String(),
  ...ZoneName.properties,
  realm: t.Nullable(ref), revision: ref, sourcePosition: readPosition,
  cost: t.Object(Object.fromEntries(Object.entries(ZONE_ROUTE_COST).map(([name, value]) =>
    [name, t.Literal(value)]))) };
const routeRead = t.Union([
  t.Object({ ...routeBasis, kind: t.Literal('home') }),
  t.Object({ ...routeBasis, kind: t.Literal('document'), mount: mountBinding, resource: resourceBinding }),
  t.Object({ ...routeBasis, kind: t.Literal('index'), mount: mountBinding, collection: ref,
    items: t.Array(t.Union([workCard, resourceBinding]), { maxItems: 24 }), nextCursor: t.Nullable(t.String()) }),
  t.Object({ ...routeBasis, kind: t.Literal('detail'), mount: t.Nullable(mountBinding),
    collection: t.Nullable(ref), resource: resourceBinding, tab: t.Nullable(t.String()) }),
]);

async function navigation(fuseki: FusekiClient, zone: string): Promise<string | null> {
  const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?navigation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:zoneState rv:Active ;
      rv:navigation ?navigation . } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  return rows.length === 1 ? rows[0]?.navigation?.value ?? null : null;
}

async function zonePage(fuseki: FusekiClient, work: MainWorkDependencies, request: Request,
  zone: string, input: { actingSubject: string; revision?: string; after?: string; limit?: number }) {
  await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
  const { principal, workPrincipal } = await zoneRouteViewer(work, request, input.actingSubject);
  if (!principal) throw new CompositionUnavailable('Zone is unavailable');
  if (!await work.access.canReadSemanticResource?.(principal, input.actingSubject, zone)) {
    throw new CompositionUnavailable('Zone is unavailable');
  }
  const state = await readZoneConfiguration(work.environment, zone);
  const structure = await navigation(fuseki, zone);
  if (!structure) throw new CompositionUnavailable('Zone is unavailable');
  const header = await readCompositionHeader(work.environment, structure);
  if (!header || header.profile !== 'zone-navigation' || header.owner !== zone) {
    throw new CompositionUnavailable('Zone is unavailable');
  }
  const result = await readVisibleCompositionPage(work.environment, { structure,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.after ? { after: input.after } : {}), limit: input.limit ?? 50,
    visible: item => item.role === 'mount' && !!item.target,
    canReadTarget: async target => {
      return canReadStructureTarget(structureProfileFor(header.profile), {
        environment: work.environment, access: {
          canReadWork: (_principal, actor, resource) => workPrincipal
            ? work.access.canReadWork(workPrincipal, actor, resource) : Promise.resolve(false),
          canReadSemanticResource: (semanticPrincipal, actor, resource) =>
            work.access.canReadSemanticResource?.(semanticPrincipal, actor, resource) ?? Promise.resolve(false),
        }, principal, actingSubject: input.actingSubject, target });
    } });
  // The optional revision selects navigation history; metadata names the current owner head.
  return { zone, navigation: structure, revision: result.revision,
    ownerRevision: state.revision, name: state.name, language: state.language, direction: state.direction,
    predecessor: result.predecessor,
    mounts: result.occurrences, next: result.next, sourcePosition: result.sourcePosition };
}

export function zoneRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  if (work.structureObjects) (work.environment as typeof work.environment
    & { structureObjects?: typeof work.structureObjects }).structureObjects = work.structureObjects;
  return new Elysia()
    .get('/v1/zones', { query: t.Object({ official: t.Literal('true'),
      after: t.Optional(t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      response: { 200: officialPage, ...errors } }, async ({ query }: { query: {
        official: 'true'; after?: string; limit?: number } }) => {
      try { return Response.json(await listOfficialZones(work.environment,
        { ...(query.after ? { after: query.after } : {}), limit: query.limit ?? 50 }),
      { headers: { 'cache-control': 'public, max-age=30' } }); }
      catch (error) { return routeError(error); }
    })
    .get('/v1/zones/by-segment/:segment', { params: t.Object({ segment: t.String({
      pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }) }),
      response: { 200: officialLookup, ...errors } }, async ({ params }: { params: { segment: string } }) => {
      try {
        const result = await officialZoneBySegment(work.environment, params.segment);
        return result ? Response.json(result, { headers: { 'cache-control': 'public, max-age=30' } })
          : problem(404, 'zone_unavailable', 'Official Zone is unavailable');
      } catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id/presentation', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref),
        safeTheme: t.Optional(t.Literal('1')), 'safe-theme': t.Optional(t.Literal('1')),
        viewerOptOut: t.Optional(t.Literal('1')) },
      { additionalProperties: false }), response: { 200: publicationRead, ...authorizedReadProblems } },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject?: string; safeTheme?: '1'; 'safe-theme'?: '1'; viewerOptOut?: '1' } }) => {
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        return await readZonePresentation(work, request, zone, query.actingSubject, async (state, navigation, viewer) => {
          const moduleData = await readZoneModuleData(work.environment, state.configuration);
          const bannerMedia = await readZoneBannerMedia(work.media?.store, state.realm,
            state.presentation.banners);
          const theme = state.presentation.official?.theme;
          const forced = query.safeTheme || query['safe-theme']
            ? { state: 'fallback' as const, reason: 'safe_mode' as const }
            : query.viewerOptOut ? { state: 'fallback' as const, reason: 'viewer_opt_out' as const }
              : null;
          const execution = forced ?? (theme && state.disclosure === 'public'
            ? zonePackageExecution(await readFirstPartyTheme(work.environment, theme.slice(-36)), zone)
            : { state: 'fallback' as const, reason: 'none_approved' as const });
          const etag = `"${hash(JSON.stringify({ revision: state.revision, navigation, moduleData, bannerMedia, execution }))}"`;
          const headers = { etag, vary: 'accept-language, x-rezics-display-languages',
            'cache-control': !viewer.principal && state.disclosure === 'public' && execution.state === 'fallback'
              && execution.reason === 'none_approved' ? 'public, max-age=30' : 'no-store' };
          if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });
          return Response.json({ profile: 'zone-presentation-response-v1', zone, realm: state.realm,
            name: state.name, language: state.language, direction: state.direction,
            official: state.official, revision: state.revision, presentation: state.presentation,
            navigation, moduleData, bannerMedia, renderTokens: zoneRenderTokens(execution.state === 'active'
              || execution.state === 'package'
              || execution.reason === 'none_approved'
              ? state.presentation.tokens : DEFAULT_ZONE_PRESENTATION.tokens),
            execution, cost: state.cost }, { headers });
        });
      } catch (error) {
        if (error instanceof ZoneRouteMissing) return problem(404, 'zone_unavailable', 'Zone is unavailable');
        return routeError(error);
      }
    })
    .get('/v1/zones/:id/routes', { params: t.Object({ id: groupUuid }),
      query: t.Object({ path: t.String({ maxLength: 256 }), cursor: t.Optional(t.String({ maxLength: 2048 })),
        actingSubject: t.Optional(ref), position: readingPositionQuery }, { additionalProperties: false }),
      response: { 200: routeRead, ...errors } }, async ({ request, params, query }) => {
      try { return Response.json(await resolveZoneRoute(work, request, {
        zone: `https://rezics.com/id/${params.id}`, ...query }), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    })
    .post('/v1/zones', { body: t.Object({ zone: ref, space: ref, disclosure, actingSubject: ref,
      name: t.Optional(t.String({ minLength: 1, maxLength: 300 })), language: t.Optional(languageTag) },
      { additionalProperties: false }), response: { 200: write, 201: write, 202: pendingOperation, ...errors } },
    async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        readZoneName(body.name, body.language);
        const requestDigest = hash(JSON.stringify({ family: 'zone-create-v1', ...body }));
        const result = await bootstrapAdmittedStructureOwner(work.environment, work.account,
          work.access, request, { profile: 'zone-navigation', owner: body.zone,
            actingSubject: body.actingSubject, idempotencyKey, requestDigest,
            createOwner: step => createAdmittedOwner(work.environment, work.account, work.access,
              request, { kind: 'zone', owner: step.owner, actingSubject: body.actingSubject,
                idempotencyKey: step.idempotencyKey, requestDigest: step.requestDigest,
                space: body.space, disclosure: body.disclosure,
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.language !== undefined ? { language: body.language } : {}) }) });
        return Response.json({ zone: result.owner, navigation: result.structure,
          revision: result.revision, receipt: result.structureReceipt, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/zones/:id/mounts', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, target: t.Optional(ref), collection: t.Optional(ref), routeSegment: t.String({
        pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
        disclosure, presentation: t.Optional(t.String({ format: 'uri' })),
        position: t.Optional(t.Union([t.Literal('first'), t.Literal('last'),
          t.Object({ after: ref }, { additionalProperties: false })])), actingSubject: ref },
      { additionalProperties: false }), response: { 200: write, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        const target = body.target ?? body.collection;
        if (!target || body.target && body.collection && body.target !== body.collection) {
          return problem(400, 'invalid_zone_change', 'A target or matching collection alias is required');
        }
        const isWork = (await fuseki.query(`PREFIX schema: <https://schema.org/> ASK {
          GRAPH ${iri(GRAPHS.current)} { ${iri(target)} a schema:CreativeWork } }`, 1024)).boolean === true;
        if (isWork) {
          const principal = await work.account.verify(request, ['work:read']);
          if (!await work.access.canReadWork(principal, body.actingSubject, target)) {
            throw new CompositionUnavailable('Structure target is unavailable');
          }
        }
        const structure = await navigation(fuseki, zone);
        if (!structure) throw new CompositionUnavailable('Zone is unavailable');
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            idempotencyKey, operations: [{ op: 'insert', parent: structure,
              position: body.position ?? 'last', role: 'mount', target,
              qualifier: { type: 'zone-mount', zone, routeSegment: body.routeSegment,
                disclosure: body.disclosure,
                ...(body.presentation ? { presentation: body.presentation } : {}) } }] });
        return Response.json({ zone, navigation: structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed, occurrences: result.occurrences ?? [],
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .delete('/v1/zones/:id/mounts/:occurrence', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref }, { additionalProperties: false }),
      response: { 200: write, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        const structure = await navigation(fuseki, zone);
        if (!structure) throw new CompositionUnavailable('Zone is unavailable');
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            idempotencyKey, operations: [{ op: 'remove',
              occurrence: `https://rezics.com/id/${params.occurrence}` }] });
        return Response.json({ zone, navigation: structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await zonePage(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, query), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: ref, after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await zonePage(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, { ...query,
          revision: `https://rezics.com/id/${params.revision}` }),
      { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id/configuration', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref }, { additionalProperties: false }),
      response: { 200: configRead, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        const principal = await work.account.verify(request, ['semantic:read']);
        if (!await work.access.canReadSemanticResource?.(principal, query.actingSubject, zone)) {
          throw new ZoneUnavailable('Zone is unavailable');
        }
        const state = await readZoneConfiguration(work.environment, zone);
        return Response.json({ zone, revision: state.revision, configuration: state.configuration,
          name: state.name, language: state.language, direction: state.direction,
          cost: state.cost }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id/query-blocks', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref }, { additionalProperties: false }),
      response: { 200: t.Any(), ...authorizedReadProblems } },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject: string } }) => {
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        const principal = await work.account.verify(request, ['semantic:read']);
        if (!await work.access.canReadSemanticResource?.(principal, query.actingSubject, zone)) {
          throw new ZoneUnavailable('Zone is unavailable');
        }
        const current = await readZoneConfiguration(work.environment, zone);
        const result = await withStableSearchSnapshot(fuseki, () => runZoneQueryBlocks(
          current.configuration, async definition => {
          if (!await work.access.canReadSemanticResource?.(principal, query.actingSubject, definition)) {
            throw new DynamicCollectionUnavailable('Dynamic Collection is unavailable');
          }
          const saved = await readDynamicDefinition(work.environment, definition);
          return executeDynamicDefinition(work.environment, saved);
          }), Math.min(current.configuration.budget.timeMs, MAX_SEARCH_REQUEST_MS));
        return Response.json({ zone, revision: current.revision, ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .put('/v1/zones/:id/configuration', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref,
        name: t.Optional(t.String({ minLength: 1, maxLength: 300 })), language: t.Optional(languageTag),
        defaultRealm: t.Optional(t.Union([ref, t.Null()])),
        official: t.Optional(t.Union([t.Object({ routeSegment: t.String({
          pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }) },
        { additionalProperties: false }), t.Null()])),
        defaultContext: t.Optional(t.Union([t.Object({ context: ref, semanticRevision: ref },
          { additionalProperties: false }), t.Null()])),
        presentation: t.Optional(t.Union([ZonePresentation, t.Null()])),
        budget: t.Optional(t.Object({ timeMs: t.Integer({ minimum: 1, maximum: 2000 }),
          rows: t.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false })),
        queryBlocks: t.Optional(t.Array(queryBlock, { maxItems: 32 })),
        advancedBase64: t.Optional(t.Union([t.String({ maxLength: 349528 }), t.Null()])),
      }, { additionalProperties: false }), response: { 200: revisionWrite, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await changeZoneConfiguration(work.environment, work.account, work.access,
          request, { zone: `https://rezics.com/id/${params.id}`,
            expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            idempotencyKey, operation: 'configure', patch: {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.language !== undefined ? { language: body.language } : {}),
              ...(body.defaultRealm !== undefined ? { defaultRealm: body.defaultRealm } : {}),
              ...(body.official !== undefined ? { official: body.official } : {}),
              ...(body.defaultContext !== undefined ? { defaultContext: body.defaultContext } : {}),
              ...(body.presentation !== undefined ? { presentation: body.presentation } : {}),
              ...(body.budget ? { budget: body.budget } : {}),
              ...(body.queryBlocks ? { queryBlocks: body.queryBlocks } : {}),
              ...(body.advancedBase64 !== undefined ? { advancedBase64: body.advancedBase64 } : {}),
            } });
        return Response.json({ zone: result.zone, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/zones/:id/retirements', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref }, { additionalProperties: false }),
      response: { 200: revisionWrite, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await changeZoneConfiguration(work.environment, work.account, work.access,
          request, { zone: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey, operation: 'retire' });
        return Response.json({ zone: result.zone, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/zones/:id/recoveries', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref }, { additionalProperties: false }),
      response: { 200: revisionWrite, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await changeZoneConfiguration(work.environment, work.account, work.access,
          request, { zone: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey, operation: 'recover' });
        return Response.json({ zone: result.zone, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    });
}
