import { GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readZoneConfiguration, ZoneUnavailable } from './configuration.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PUBLIC_READ_SOURCES } from './presentation-format.ts';
import { readDynamicDefinition, executeDynamicDefinition } from '../collection/dynamic.ts';
import { withStableSearchSnapshot, MAX_SEARCH_REQUEST_MS } from '../work/search-readiness.ts';
import { runZoneQueryBlocks, ZoneQueryBudgetExceeded } from './query-budget.ts';
import type { ZoneConfiguration } from './config-format.ts';
import { readCompositionPage } from '../structure/read.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import type { MediaStore } from '../media/store.ts';
import { ZONE_ROUTE_COST } from './route-cost.ts';

export const ZONE_PUBLICATION_COST = { graphReads: 1, objectReads: 2,
  officialPageSize: 50, maxModules: 24, maxBanners: 6, maxBannerMediaReads: 6,
  maxResolvedBlocks: 4, maxResolvedCollections: 2, maxCollectionPlacements: 8,
  maxModuleGraphReads: 64, maxNavigation: ZONE_ROUTE_COST.maxNavigation,
  maxNavigationGraphReads: ZONE_ROUTE_COST.maxGraphReads } as const;

export async function readZonePublication(env: WorkActivationEnvironment, zone: string) {
  const state = await readZoneConfiguration(env, zone);
  if (state.state !== 'active') throw new ZoneUnavailable('Zone is retired');
  const presentation = typeof state.configuration.presentation === 'object'
    ? state.configuration.presentation : DEFAULT_ZONE_PRESENTATION;
  return { zone, realm: state.configuration.defaultRealm ?? null,
    official: state.configuration.official?.routeSegment ?? null,
    revision: state.revision, disclosure: state.disclosure, presentation,
    configuration: state.configuration,
    etag: `"${hash(JSON.stringify({ revision: state.revision, presentation }))}"`,
    cost: ZONE_PUBLICATION_COST };
}

/** A banner is delivered only from an active public Realm publication item.
 * At most six exact Content lookups; an unusable image leaves the banner's text intact. */
export async function readZoneBannerMedia(store: Pick<MediaStore, 'itemDelivery'> | undefined,
  realm: string | null, banners: readonly { id: string; image: string }[]) {
  return Promise.all(banners.map(async banner => {
    const use = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(banner.image)?.[1];
    const item = use && store && realm ? await store.itemDelivery(use) : null;
    return { id: banner.id, image: item && item.target === realm
      && item.availability === 'available' && item.disclosure === 'public'
      && item.moderation === 'none' && item.lifecycle === 'active'
      && Number.isSafeInteger(item.width) && item.width > 0
      && Number.isSafeInteger(item.height) && item.height > 0
      ? { url: `/v1/media/uses/${use}`, width: item.width, height: item.height,
        mediaType: item.mediaType } : null };
  }));
}

/** Public module data resolves only disclosed query definitions, within the Zone's shared budget. */
export async function readZoneModuleData(env: WorkActivationEnvironment,
  config: ZoneConfiguration) {
  let graphReads = 0;
  const boundedFuseki = new Proxy(env.fuseki, { get(target, property) {
    if (property === 'query') return (...args: Parameters<typeof target.query>) => {
      if (++graphReads > ZONE_PUBLICATION_COST.maxModuleGraphReads) {
        throw new ZoneQueryBudgetExceeded('Zone presentation graph read budget exceeded');
      }
      return target.query(...args);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const bounded = { ...env, fuseki: boundedFuseki };
  const presentation = typeof config.presentation === 'object'
    ? config.presentation : DEFAULT_ZONE_PRESENTATION;
  const used = new Set(presentation.modules.flatMap(module => [module.source,
    ...(module.tabs ?? []).map(tab => tab.source)]).filter(source => source.kind === 'query-block')
    .map(source => source.kind === 'query-block' ? source.block : '')
    .filter(block => !(ZONE_PUBLIC_READ_SOURCES as readonly string[]).includes(block)));
  const selectedBlocks = [...used].slice(0, ZONE_PUBLICATION_COST.maxResolvedBlocks);
  const query = used.size ? await withStableSearchSnapshot(boundedFuseki,
    () => runZoneQueryBlocks({ ...config, queryBlocks: config.queryBlocks.filter(block =>
      selectedBlocks.includes(block.block)) },
      async definition => {
        const saved = await readDynamicDefinition(bounded, definition);
        if (saved.disclosure !== 'public') throw new ZoneUnavailable('private module definition');
        return executeDynamicDefinition(bounded, saved);
      }), Math.min(config.budget.timeMs, MAX_SEARCH_REQUEST_MS)) : null;
  const blocks = new Map(query?.results.map(result => [result.block, result]) ?? []);
  const collections = [...new Set(presentation.modules.flatMap(module => [module.source,
    ...(module.tabs ?? []).map(tab => tab.source)]).filter(source => source.kind === 'collection')
    .map(source => source.kind === 'collection' ? source.collection : ''))]
    .slice(0, ZONE_PUBLICATION_COST.maxResolvedCollections);
  const collectionData = new Map<string, { state: 'complete' | 'partial' | 'unavailable';
    members: { work: string; selection?: unknown }[] }>();
  for (const collection of collections) {
    const match = await boundedFuseki.query(`PREFIX rv: <${RV}> SELECT ?structure WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} a rv:Collection ;
        rv:collectionState rv:Active ; rv:disclosure rv:Public ; rv:structure ?structure . }
    } LIMIT 2`, 4096);
    const structure = match.results?.bindings.length === 1
      ? match.results.bindings[0]?.structure?.value : null;
    if (!structure) {
      collectionData.set(collection, { state: 'unavailable', members: [] });
      continue;
    }
    const page = await readCompositionPage(bounded, { structure,
      limit: ZONE_PUBLICATION_COST.maxCollectionPlacements,
      canReadTarget: async target => {
        const result = await boundedFuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:work ${iri(target)} ;
            rv:disclosure rv:Public ; rv:mainVersion ?main ; rv:selection ?selection . }
          GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?selection . }
        }`, 1024);
        return result.boolean === true;
      } });
    collectionData.set(collection, { state: page.next ? 'partial' : 'complete',
      members: page.occurrences.filter(item => item.role === 'member' && !!item.target)
        .map(item => ({ work: item.target!, ...(item.selection ? { selection: item.selection } : {}) })) });
  }
  return presentation.modules.map(module => ({ id: module.id,
    sources: [module.source, ...(module.tabs ?? []).map(tab => tab.source)].map(source =>
      source.kind === 'query-block'
        ? { source, state: (ZONE_PUBLIC_READ_SOURCES as readonly string[]).includes(source.block)
          ? 'public-read' as const : blocks.get(source.block)?.state ?? 'skipped',
          members: blocks.get(source.block)?.members ?? [] }
        : source.kind === 'collection'
          ? { source, state: collectionData.get(source.collection)?.state ?? 'skipped',
            members: collectionData.get(source.collection)?.members ?? [] }
          : { source, state: 'reference' as const, members: [] }),
  }));
}

export async function listOfficialZones(env: WorkActivationEnvironment,
  input: { after?: string; limit: number }) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?zone ?realm ?segment WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
      rv:disclosure rv:Public ; rv:defaultRealm ?realm ; rv:routeSegment ?segment .
      ${input.after ? `FILTER(STR(?segment) > ${lit(input.after)})` : ''}
    } } ORDER BY ?segment LIMIT ${input.limit + 1}`);
  const rows = result.results?.bindings ?? [];
  const items = rows.slice(0, input.limit).map(row => {
    if (!row.zone?.value || !row.realm?.value || !row.segment?.value) {
      throw new ZoneUnavailable('Official Zone directory is incomplete');
    }
    return { zone: row.zone.value, realm: row.realm.value, routeSegment: row.segment.value };
  });
  return { items, next: rows.length > input.limit ? items.at(-1)?.routeSegment ?? null : null,
    cost: { graphReads: 1, rows: rows.length } };
}

export async function officialZoneBySegment(env: WorkActivationEnvironment, segment: string) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?zone ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
      rv:disclosure rv:Public ; rv:defaultRealm ?realm ; rv:routeSegment ${lit(segment)} . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.zone?.value || !rows[0]?.realm?.value) {
    throw new ZoneUnavailable('Official route segment is ambiguous');
  }
  return { zone: rows[0].zone.value, realm: rows[0].realm.value, routeSegment: segment,
    cost: { graphReads: 1, rows: rows.length } };
}
