import { GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readZoneConfiguration, ZoneUnavailable } from './configuration.ts';
import { uuidToSid } from '@rezics/model/address/sid';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PUBLIC_READ_SOURCES } from './presentation-format.ts';
import { readDynamicDefinition, executeDynamicDefinition } from '../collection/dynamic.ts';
import { withStableSearchSnapshot, MAX_SEARCH_REQUEST_MS } from '../work/search-readiness.ts';
import { runZoneQueryBlocks, ZoneQueryBudgetExceeded } from './query-budget.ts';
import { InvalidZoneConfiguration,type ZoneConfiguration } from './config-format.ts';
import { readCompositionPage } from '../structure/read.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { MediaUnavailable, type MediaStore } from '../media/store.ts';
import { ZONE_ROUTE_COST } from './route-cost.ts';
import { pageDiscoveryPolicy } from '../space/visibility.ts';
import { identityCanonical } from '../address/canonical.ts';

export const ZONE_PUBLICATION_COST = { graphReads: 1, objectReads: 2,
  officialPageSize: 50, maxModules: 24, maxBanners: 6, maxBannerMediaReads: 1,
  maxResolvedBlocks: 4, maxResolvedCollections: 2, maxCollectionPlacements: 8,
  maxModuleGraphReads: 64, maxNavigation: ZONE_ROUTE_COST.maxNavigation,
  maxNavigationGraphReads: ZONE_ROUTE_COST.maxGraphReads } as const;

export async function readZonePublication(env: WorkActivationEnvironment, zone: string) {
  const state = await readZoneConfiguration(env, zone);
  if (state.state !== 'active') throw new ZoneUnavailable('Zone is retired');
  const disclosure = state.disclosure === 'private' || state.spaceVisibility === 'private' ? 'private' as const : 'public' as const;
  const presentation = typeof state.configuration.presentation === 'object'
    ? state.configuration.presentation : DEFAULT_ZONE_PRESENTATION;
  const name = (await env.addresses?.currents([state.space]).catch(() => new Map()))?.get(`space\0${state.space}`);
  const address = { ...identityCanonical('zone', state.space, disclosure === 'public' ? state.name ?? '' : ''),
    ...(name ? { key: name.key } : {}) };
  return { zone, realm: state.configuration.defaultRealm ?? null,
    address,
    name: state.name, language: state.language, direction: state.direction,
    official: state.configuration.official ? address.key : null,
    revision: state.revision,
    disclosure,storedDisclosure: state.disclosure,space:state.space,listing: state.listing,
    discovery: pageDiscoveryPolicy(disclosure,state.listing),presentation,
    configuration: state.configuration,
    etag: `"${hash(JSON.stringify({ revision: state.revision, presentation,disclosure,listing:state.listing,address }))}"`,
    cost: ZONE_PUBLICATION_COST };
}

/** A banner is delivered only from an active public Realm publication item.
 * One exact Content batch for at most six distinct Uses, independent of corpus,
 * memberships and history; an unusable image leaves the banner's text intact. */
export async function readZoneBannerMedia(store: Pick<MediaStore, 'itemDeliveryBatch'>
  | Pick<MediaStore, 'itemDelivery'> | undefined,
  realm: string | null, banners: readonly { id: string; image: string }[]) {
  const uses = banners.map(banner => /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(banner.image)?.[1]);
  const selected = uses.filter((use): use is string => !!use);
  const items = new Map<string, NonNullable<Awaited<ReturnType<MediaStore['itemDelivery']>>>>();
  if (store && realm && selected.length) {
    if ('itemDeliveryBatch' in store) {
      for (const [use, item] of await store.itemDeliveryBatch(selected)) items.set(use, item);
    } else {
      // A single-item adapter also meets the one-statement contract. Multiple
      // distinct Uses require the batch owner rather than a point-read loop.
      const unique = [...new Set(selected)];
      if (unique.length !== 1) throw new MediaUnavailable('Zone banner batch owner is unavailable');
      const item = await store.itemDelivery(unique[0]!);
      if (item) items.set(unique[0]!, item);
    }
  }
  return banners.map((banner, index) => {
    const use = uses[index];
    const item = use ? items.get(use) : null;
    return { id: banner.id, image: item && item.target === realm
      && item.availability === 'available' && item.disclosure === 'public'
      && item.moderation === 'none' && item.lifecycle === 'active'
      && Number.isSafeInteger(item.width) && item.width > 0
      && Number.isSafeInteger(item.height) && item.height > 0
      ? { url: `/v1/media/uses/${use}`, width: item.width, height: item.height,
        mediaType: item.mediaType } : null };
  });
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
  await assertGraphAdmissionOpen(env.fuseki,env.lineage);
  if (input.after && !/^v2:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.after)) throw new InvalidZoneConfiguration('Unsupported official Zone cursor; restart the listing');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?zone ?realm ?space ?name WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
      rv:disclosure rv:Public ; rv:defaultRealm ?realm ; rv:space ?space .
      ?space rv:disclosure rv:Public .
      OPTIONAL { ?zone rdfs:label ?name }
      FILTER NOT EXISTS { ?space rv:listing "unlisted" }
      FILTER NOT EXISTS { ?space rv:protectionHead ?protection }
      FILTER NOT EXISTS { ?zone rv:protectionHead ?zoneProtection }
      ${input.after ? `FILTER(STR(?zone) > ${lit(input.after.slice(3))})` : ''}
    } } ORDER BY STR(?zone) LIMIT ${input.limit + 1}`)).results?.bindings ?? [];
  const selected = rows.slice(0,input.limit);
  const spaces = [...new Set(selected.map(row => row.space!.value))];
  const names = await env.addresses?.currents(spaces).catch(() => new Map());
  const items = selected.map(row => {
    const address = { ...identityCanonical('zone', row.space!.value, row.name?.value ?? ''),
      key: names?.get(`space\0${row.space!.value}`)?.key ?? uuidToSid(row.space!.value.slice(-36)) };
    return { zone: row.zone!.value,realm: row.realm!.value,routeSegment: address.key,address };
  });
  return { items,next: rows.length > input.limit ? `v2:${selected.at(-1)!.zone!.value}` : null,
    cost: { graphReads: 1,rows: rows.length } };
}
