import { isDeepStrictEqual } from 'node:util';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readZoneConfiguration, readZoneRevisionConfiguration, readZoneSitePublicationReceipt, ZoneUnavailable } from './configuration.ts';
import { uuidToSid } from '@rezics/model/address/sid';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PUBLIC_READ_SOURCES } from './presentation-format.ts';
import { readDynamicDefinition, executeDynamicDefinition } from '../collection/dynamic.ts';
import { withStableSearchSnapshot, MAX_SEARCH_REQUEST_MS } from '../work/search-readiness.ts';
import { runZoneQueryBlocks, ZoneQueryBudgetExceeded } from './query-budget.ts';
import { InvalidZoneConfiguration, ZONE_SITE_PUBLICATION_COST, ZonePublishedPage,
  zonePublishedPageBinding, type ZoneConfiguration } from './config-format.ts';
import { Value } from 'typebox/value';
import { readCompositionPage } from '../structure/read.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { ZONE_CAMPAIGN_ART_COST, readZoneCampaignArt, bindZoneCampaignArtVariant } from './campaign-art.ts';
import { ZONE_ROUTE_COST } from './route-cost.ts';
import { pageDiscoveryPolicy, readZoneVisibilities } from '../space/visibility.ts';
import { captureHomeDisclosureFence } from './home-disclosure-fence.ts';
import { identityCanonical } from '../address/canonical.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { parseDocument } from '@rezics/document';
import { Type, type Static } from 'typebox';
import { exactContentRevision } from '../../api-responses.ts';
import { ZonePageDocument, resolveZonePageDocument, zoneDocumentShowcase } from '../presentation/zone-document.ts';
import { readerLanguages, selectDisplayName } from '../display-language/select.ts';
import { discloseContent } from '../disclosure/assembly.ts';
import { currentDisclosureViewer, withDisclosureViewer } from '../disclosure/viewer.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { ZonePublicationUnavailable } from './configuration.ts';
import { readRealmPolicy } from '../space/policy.ts';

export const ZonePublicPage = Type.Object({ ...ZonePageDocument.properties,
  reference: exactContentRevision.properties.reference }, { additionalProperties: false });
export type ZonePublicPage = Static<typeof ZonePublicPage>;

export const ZONE_PUBLICATION_COST = { graphReads: 1, objectReads: 2,
  officialPageSize: 50, maxModules: 24, ...ZONE_CAMPAIGN_ART_COST,
  maxResolvedBlocks: 4, maxResolvedCollections: 2, maxCollectionPlacements: 8,
  maxModuleGraphReads: 64, maxNavigation: ZONE_ROUTE_COST.maxNavigation,
  maxNavigationGraphReads: ZONE_ROUTE_COST.maxGraphReads } as const;

export async function readZonePublication(env: WorkActivationEnvironment, zone: string) {
  const state = await readZoneConfiguration(env, zone);
  if (state.state !== 'active') throw new ZoneUnavailable('Zone is retired');
  let bundle: Awaited<ReturnType<typeof readZoneSitePublicationReceipt>> = null;
  let publishedRevision = state.revision;
  let published = { configuration: state.configuration, name: state.name, language: state.language, direction: state.direction };
  if (state.publicationRevision) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(state.publicationRevision)} a rv:ZoneRevision ;
        rv:component ${iri(zone)} ; rv:sitePublicationReceipt ?receipt . }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.receipt?.value) throw new ZoneUnavailable('Published Zone bundle is unavailable');
    bundle = await readZoneSitePublicationReceipt(env, rows[0].receipt.value, true);
    if (!bundle || bundle.zone !== zone || bundle.revision !== state.publicationRevision) {
      throw new ZoneUnavailable('Published Zone bundle differs from its selected head');
    }
    published = await readZoneRevisionConfiguration(env, state, bundle.themeRevision);
    publishedRevision = bundle.revision;
  } else if (state.documentSite) {
    // Zone-only sites expose their creation shell until their first bundle.
    // A configuration or navigation draft cannot become an implicit publication.
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?creation WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?creation a rv:ZoneRevision ;
        rv:component ${iri(zone)} ; rv:zoneOperation rv:ZoneCreate . }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.creation?.value) throw new ZoneUnavailable('Zone creation shell is unavailable');
    published = await readZoneRevisionConfiguration(env, state, rows[0].creation.value);
    publishedRevision = rows[0].creation.value;
  }
  const disclosure = state.disclosure === 'private' || state.spaceVisibility === 'private' ? 'private' as const : 'public' as const;
  const presentation = typeof published.configuration.presentation === 'object'
    ? published.configuration.presentation : DEFAULT_ZONE_PRESENTATION;
  const name = (await env.addresses?.currents([state.space]).catch(() => new Map()))?.get(`space\0${state.space}`);
  const address = { ...identityCanonical('zone', state.space, disclosure === 'public' ? published.name ?? '' : ''),
    ...(name ? { key: name.key } : {}) };
  return { zone, realm: published.configuration.defaultRealm ?? null,
    address,
    name: published.name, language: published.language, direction: published.direction,
    official: published.configuration.official ? address.key : null,
    revision: publishedRevision, currentRevision: state.revision, bundle,
    documentSite: state.documentSite,
    publicationRevision: state.publicationRevision,
    disclosure,storedDisclosure: state.disclosure,space:state.space,listing: state.listing,
    discovery: pageDiscoveryPolicy(disclosure,state.listing),presentation,
    configuration: published.configuration,
    etag: `"${hash(JSON.stringify({ revision: publishedRevision, presentation,disclosure,listing:state.listing,address }))}"`,
    cost: { ...ZONE_PUBLICATION_COST, graphReads: bundle ? 4 : state.documentSite ? 3 : 1,
      objectReads: bundle || state.documentSite ? 4 : 2 } };
}

/** Publication advances the configuration head without changing its saved
 * meaning. Compare the complete saved home selection to the retained bundle,
 * including layout and links, rather than treating that revision as a draft. */
export function zoneSavedPublicationStatus(
  saved: Awaited<ReturnType<typeof readZoneConfiguration>>,
  published: Awaited<ReturnType<typeof readZonePublication>>,
  selection: { variantId: string; revisionId: string | null; navigationRevision: string },
): 'private' | 'live' | 'behind' {
  const bundle = published.bundle;
  if (published.disclosure !== 'public' || !bundle) return 'private';
  const page = bundle.pages.find(page => page.page === (saved.configuration.homeDocument ?? saved.zone));
  if (!page || page.variantId !== selection.variantId || page.revisionId !== selection.revisionId
    || bundle.navigationRevision !== selection.navigationRevision
    || bundle.routesRevision !== selection.navigationRevision) return 'behind';
  const effective = (configuration: ZoneConfiguration) => ({ ...configuration,
    presentation: typeof configuration.presentation === 'object' ? configuration.presentation : DEFAULT_ZONE_PRESENTATION });
  return saved.name === published.name && saved.language === published.language
    && saved.direction === published.direction
    && isDeepStrictEqual(effective(saved.configuration), effective(published.configuration))
    ? 'live' : 'behind';
}

/** Indexed membership of the current public bundle. The configuration head
 * selects the revision; one binding ASK proves its Content pin and receipt
 * link. Home rendering owns the receipt body, so this check leaves that body
 * unread: a missing presentation cut must not refuse before the caller's
 * rights and delivery fences. A gone pin or receipt link still refuses.
 * Recheck visibility, recovery and the selected head in the same graph snapshot. */
export async function isZonePublishedPageRevision(env: WorkActivationEnvironment,
  zone: string, page: string, revisionId: string): Promise<boolean> {
  if (!Value.Check(ZonePublishedPage.properties.page, zone)
    || !Value.Check(ZonePublishedPage.properties.page, page)
    || !Value.Check(ZonePublishedPage.properties.revisionId, revisionId)) return false;
  let state: Awaited<ReturnType<typeof readZoneConfiguration>>;
  try { state = await readZoneConfiguration(env, zone); }
  catch (error) {
    if (error instanceof ZoneUnavailable) return false;
    throw error;
  }
  const disclosure = state.disclosure === 'private' || state.spaceVisibility === 'private' ? 'private' : 'public';
  if (state.state !== 'active' || disclosure !== 'public' || !state.publicationRevision) return false;
  const revision = state.publicationRevision;
  const binding = zonePublishedPageBinding(revision, page, revisionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:zoneState rv:Active ;
      rv:space ${iri(state.space)} ; rv:sitePublicationHead ${iri(revision)} .
      ${iri(state.space)} a rv:Space ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ${iri(zone)} rv:protectionHead ?zoneProtection }
      FILTER NOT EXISTS { ${iri(state.space)} rv:protectionHead ?spaceProtection } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ZoneRevision ;
      rv:component ${iri(zone)} ; rv:sitePublicationReceipt ?receipt .
      ${iri(binding)} rv:sitePublicationRevision ${iri(revision)} ;
        rv:page ${iri(page)} ; rv:contentRevision ${iri(`urn:rezics:content:revision:${revisionId}`)} .
      FILTER NOT EXISTS { ${iri(`urn:rezics:content:revision:${revisionId}`)} a rv:ErasedRevision }
      FILTER NOT EXISTS { ${iri(revision)} rv:homeRevision ?homeCut . ?homeCut a rv:ErasedRevision } }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:structureOwner ${iri(zone)} ; rv:sitePublicationRevision ${iri(revision)} ;
      rv:admittedScope ${lit(`zone:edit:${zone}`)} ; rv:publishedPage ${iri(binding)} . }
  }`, ZONE_SITE_PUBLICATION_COST.membershipResponseBytes);
  return result.boolean === true;
}

export { readZoneCampaignArt } from './campaign-art.ts';

/** One exact body per home read. Languages are the Content owner's immutable
 * publication metadata, so selecting one never enumerates or loads draft bodies. */
export async function readZonePublishedHomeContent(
  work: Pick<MainWorkDependencies, 'environment' | 'content' | 'contentAuthoring'>,
  state: Awaited<ReturnType<typeof readZonePublication>>, languages: readonly string[] = [], variantId?: string) {
  if (variantId !== undefined && (!Value.Check(ZonePublishedPage.properties.variantId, variantId)
    || !state.bundle)) throw new ZoneUnavailable('Published Zone home is unavailable');
  if (!state.bundle || state.disclosure !== 'public' || state.bundle.homeErased) return null;
  const visible = await homeCutVisible(work.environment, state);
  if (state.bundle.homeErased || !visible) return null;
  const pages = state.bundle.pages.filter(page => page.page === (state.bundle!.homeDocument ?? state.zone));
  const selected = selectDisplayName(new Map(pages.map(page => [page.language ?? 'und', page.revisionId])),
    languages);
  const page = variantId !== undefined ? pages.find(page => page.variantId === variantId)
    : pages.find(page => page.revisionId === selected?.value) ?? pages[0];
  if (!page) throw new ZoneUnavailable('Published Zone home is unavailable');
  const fence = await capturePublicationHomeFence(work.environment, state, page);
  if (!work.content) throw new ZonePublicationUnavailable('Content owner is unavailable');
  if (!await isZonePublishedPageRevision(work.environment, state.zone, page.page, page.revisionId)) {
    if (await erasedHomeCut(work.environment, state)) return null;
    throw new ZoneUnavailable('Published Zone home is unavailable');
  }
  const viewer = currentDisclosureViewer();
  const results = await withDisclosureViewer(viewer, () => work.content!.readExactBatch([page.revisionId],
    async ids => new Set(ids)));
  const exact = (await discloseContent(work.environment, results, viewer))[0];
  if (exact?.status === 'erased' || exact?.status === 'denied') return null;
  if (exact?.status !== 'available' || exact.reference.resourceId !== page.page
    || exact.reference.variantId !== page.variantId || exact.body.document === undefined) {
    throw new ZoneUnavailable('Published Zone home is unavailable');
  }
  const document = parseDocument(exact.body.document);
  if (document.profile !== 'blocks') throw new ZoneUnavailable('Published Zone home is not a Blocks document');
  try { await assertZoneHomeContentCurrent(work, state, page, exact.reference.byteDigest); }
  catch (error) {
    if (error instanceof ZoneUnavailable && (await erasedHomeCut(work.environment, state)
      || !await homeCutVisible(work.environment, state))) return null;
    throw error;
  }
  const home = { page, document, reference: exact.reference };
  return await fence() ? home : null;
}

async function capturePublicationHomeFence(env: WorkActivationEnvironment,
  state: Awaited<ReturnType<typeof readZonePublication>>, page: { page: string; revisionId: string }) {
  if (!state.bundle?.homeDocument || !state.bundle.homeRevision) return async () => true;
  const resource = state.bundle.homeDocument;
  const fence = await captureHomeDisclosureFence(env, [{ resource, zone: state.zone,
    targets: [{ owner: 'graph', resource, revision: state.bundle.homeRevision, component: 'record' },
      { owner: 'content', resource: page.page, revision: page.revisionId, component: 'body',
        occurrence: { owner: 'graph', kind: 'publication', resource, revision: state.bundle.homeRevision } }] }],
  currentDisclosureViewer(), 'read', async () => {
    const zones = await readZoneVisibilities(env, [state.zone]);
    return new Set(zones.get(state.zone)?.readable && zones.get(state.zone)?.visibility === 'public' ? [state.zone] : []);
  });
  return async () => (await fence()).has(resource);
}

async function homeCutVisible(env: WorkActivationEnvironment,
  state: Awaited<ReturnType<typeof readZonePublication>>): Promise<boolean> {
  if (!state.bundle?.homeDocument || !state.bundle.homeRevision) return true;
  return (await discloseInventory(env, [{ owner: 'graph', resource: state.bundle.homeDocument,
    revision: state.bundle.homeRevision, component: 'record' }], currentDisclosureViewer(), 'read'))[0] === 'visible';
}

async function erasedHomeCut(env: WorkActivationEnvironment,
  state: Awaited<ReturnType<typeof readZonePublication>>): Promise<boolean> {
  if (!state.bundle?.homeRevision) return false;
  return (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(state.bundle.homeRevision)} a rv:ErasedRevision }
  }`, 1024)).boolean === true;
}

export async function assertZoneHomeContentCurrent(
  work: Pick<MainWorkDependencies, 'environment' | 'contentAuthoring'>,
  state: Awaited<ReturnType<typeof readZonePublication>>,
  page: { page: string; revisionId: string }, byteDigest: string) {
  const metadata = work.contentAuthoring && await work.contentAuthoring.readExactMetadataBatch([page.revisionId],
    async ids => new Set(ids));
  if (metadata && (metadata.get(page.revisionId)?.availability !== 'available'
    || metadata.get(page.revisionId)?.byteDigest !== byteDigest)
    || !await isZonePublishedPageRevision(work.environment, state.zone, page.page, page.revisionId)
    || !await homeCutVisible(work.environment, state)) {
    throw new ZoneUnavailable('Published Zone home changed during the read');
  }
}

export async function readZoneHomeDocument(work: MainWorkDependencies, request: Request,
  state: Awaited<ReturnType<typeof readZonePublication>>,
  moduleData?: Awaited<ReturnType<typeof readZoneModuleData>>,
  slideMedia?: Awaited<ReturnType<typeof readZoneCampaignArt>>,
  visibleSlides?: (slides: typeof state.presentation.slides) => Promise<typeof state.presentation.slides>): Promise<ZonePublicPage | null> {
  const home = await readZonePublishedHomeContent(work, state,
    readerLanguages(request.headers.get('x-rezics-display-languages'), request.headers.get('accept-language')));
  if (!home) return null;
  const { document, page, reference } = home;
  const fence = await capturePublicationHomeFence(work.environment, state, page);
  const local = zoneDocumentShowcase(document);
  let localData: Parameters<typeof resolveZonePageDocument>[4];
  if (local) {
    if (!visibleSlides) throw new ZoneUnavailable('Zone slide disclosure reader is unavailable');
    const slides = await visibleSlides(local.payload['rv:slides']);
    // The payload owns curated choices. Live definitions, collection members and
    // media still pass through the same bounded disclosure owners as legacy Zones.
    const presentation = { ...state.presentation, modules: local.payload['rv:module'],
      slides };
    const [modules, media] = await Promise.all([
      readZoneModuleData(work.environment, { ...state.configuration, presentation }),
      readZoneCampaignArt(work.media?.store, state.realm, presentation.slides,
        { environment: work.environment, zone: state.zone, variantId: page.variantId }),
    ]);
    localData = { sources: modules[0]?.sources ?? [], slideMedia: media, slides };
  }
  const resolved = resolveZonePageDocument(document, state.presentation,
    moduleData ?? await readZoneModuleData(work.environment, state.configuration),
    slideMedia ? bindZoneCampaignArtVariant(slideMedia, state.zone, page.variantId)
      : await readZoneCampaignArt(work.media?.store, state.realm, state.presentation.slides,
        { environment: work.environment, zone: state.zone, variantId: page.variantId }), localData);
  try { await assertZoneHomeContentCurrent(work, state, page, reference.byteDigest); }
  catch (error) {
    if (error instanceof ZoneUnavailable && (await erasedHomeCut(work.environment, state)
      || !await homeCutVisible(work.environment, state))) return null;
    throw error;
  }
  const result = { ...resolved, reference };
  return await fence() ? result : null;
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
  const publicRealmSources = presentation.modules.some(module => [module.source,
    ...(module.tabs ?? []).map(tab => tab.source)].some(source => source.kind === 'query-block'
      && (ZONE_PUBLIC_READ_SOURCES as readonly string[]).includes(source.block)));
  const realmPolicy = publicRealmSources && config.defaultRealm
    ? await readRealmPolicy(bounded, config.defaultRealm) : null;
  const publicRealm = realmPolicy !== null && realmPolicy.visibility !== 'private';
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
          ? publicRealm ? 'public-read' as const : 'unavailable' as const : blocks.get(source.block)?.state ?? 'skipped',
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
      rv:defaultRealm ?realm ; rv:space ?space .
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
