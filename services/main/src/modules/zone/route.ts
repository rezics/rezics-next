import { setTimeout as delay } from 'node:timers/promises';
import { fusekiReadBudget, FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge,
  type SparqlResult } from '../../infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type {} from '../../routes/media.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readVisibleCompositionPage } from '../collection/visible-page.ts';
import { readerLanguages } from '../display-language/select.ts';
import { readResourceSummaries, type ResourceSummary, type SummaryReader } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { NATIVE_ID, readCompositionHeader, type CompositionHeader } from '../structure/graph.ts';
import { DATASET, GRAPHS, RV, WORK_SEMANTIC_TYPES, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadSession, WorkReadMoved,
  WorkReadExpired, WorkReadLimit, WorkReadMissing, WorkReadUnavailable, type ReadPosition } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import type { WorkCard } from '../work/read-header.ts';
import { readZonePublication, readZoneHomeDocument, type ZonePublicPage } from './publication.ts';
import { ZoneUnavailable } from './configuration.ts';
import { parseZonePath } from './route-path.ts';
import { ZONE_ROUTE_COST } from './route-cost.ts';
import { collectionPopulation, realmPopulation, readZonePopulation, ZONE_POPULATION_COST }
  from './route-population.ts';
import { ReadingBoundary } from '../reading-position/boundary.ts';
import { identityKeyUuid, uuidToSid } from '@rezics/model/address/sid';
import type { CanonicalAddress } from '@rezics/model/address';
import { canonicalAddresses } from '../address/canonical.ts';
import { readZoneVisibility } from './route-visibility.ts';
import { slideIsCurrent } from './showcase-disclosure.ts';
export { ZONE_ROUTE_COST } from './route-cost.ts';

export class ZoneRouteMissing extends Error {}
export class ZoneRouteRetired extends ZoneRouteMissing {}
type Publication = Awaited<ReturnType<typeof readZonePublication>>;
type Available = Extract<ResourceSummary, { status: 'available' }>;
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
export interface ZoneMountBinding { occurrence: string; segment: string; target: string; key?: 'alias' | 'id' }
export interface ZoneNavigationItem extends ZoneMountBinding {
  kind: 'document' | 'index'; name: Available['name'];
}
interface ResourceBinding { id: string; types: string[]; name: Available['name']; address: CanonicalAddress }
interface RouteBasis { profile: 'zone-route-v1'; zone: string; path: string;
  name: Publication['name']; language: string; direction: Publication['direction'];
  listing: Publication['listing']; discovery: Publication['discovery'];
  realm: string | null; revision: string; sourcePosition: ReadPosition; cost: typeof ZONE_ROUTE_COST }
export type ZoneRoute = RouteBasis & (
  { kind: 'home'; page?: ZonePublicPage }
  | { kind: 'document'; mount: ZoneMountBinding; resource: ResourceBinding }
  | { kind: 'index'; mount: ZoneMountBinding; collection: string;
    items: Array<(WorkCard | ResourceBinding) & { inZone: boolean }>; nextCursor: string | null }
  | { kind: 'detail'; mount: ZoneMountBinding | null; collection: string | null;
    resource: ResourceBinding; tab: string | null });

export interface ZoneRouteViewer {
  principal: VerifiedPrincipal | null; workPrincipal: VerifiedPrincipal | null; actingSubject?: string;
}

/** Presentation and route reads share optional semantic-read authentication. */
export async function zoneRouteViewer(work: MainWorkDependencies, request: Request,
  actingSubject?: string): Promise<ZoneRouteViewer> {
  const principal = actingSubject ? await work.account.verify(request, ['semantic:read']) : null;
  let workPrincipal: VerifiedPrincipal | null = null;
  if (principal) {
    try { workPrincipal = await work.account.verify(request, ['work:read']); }
    catch { /* Semantic scope alone cannot authorize a private Work. */ }
  }
  return { principal, workPrincipal,
    ...(actingSubject ? { actingSubject } : {}) };
}

function summaryReader(work: MainWorkDependencies, viewer: ZoneRouteViewer): SummaryReader {
  const { principal, workPrincipal, actingSubject } = viewer;
  return {
    ...(work.mediaAccess ? {
      canReadSemantics: (resources: readonly string[]) => work.mediaAccess!.canReadSemantics(principal,
        actingSubject ?? null, resources, work.environment.fuseki),
    } : {}),
    ...(workPrincipal && actingSubject ? {
      canReadWork: (target: string) => work.access.canReadWork(workPrincipal, actingSubject, target),
    } : {}),
    ...(principal && actingSubject ? {
      canReadSemantic: (target: string) => work.access.canReadSemanticResource?.(principal,
        actingSubject, target) ?? Promise.resolve(false),
    } : {}),
    ...(work.governance?.store ? { restrictedTitles: (heads: readonly { work: string; revision: string }[],
      context: string) => work.governance!.store.restrictedTitles(heads, context) } : {}),
  };
}

async function position(work: MainWorkDependencies): Promise<ReadPosition> {
  const rows = (await work.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(work.environment.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(work.environment.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.sequence?.value ?? '')) {
    throw new WorkReadUnavailable('Zone graph position is unavailable');
  }
  return { dataEpoch: work.environment.lineage.dataEpoch, sequence: rows[0]!.sequence!.value };
}

class RouteRead {
  readonly reader: SummaryReader;
  readonly boundary: ReadingBoundary;
  readonly summaries = new Map<string, Available | null>();
  readonly requiredSemantics = new Set<string>();
  readonly privateZones = new Set<string>();
  readonly scopeSession: WorkReadSession;
  constructor(readonly work: MainWorkDependencies, readonly request: Request,
    readonly viewer: ZoneRouteViewer, readonly position: ReadPosition) {
    const session = new WorkReadSession(work, request, { actingSubject: viewer.actingSubject }, position);
    session.principal = viewer.workPrincipal;
    this.scopeSession = new WorkReadSession(work, request, { actingSubject: viewer.actingSubject }, position);
    this.scopeSession.principal = viewer.principal;
    this.boundary = new ReadingBoundary(session);
    this.reader = { ...summaryReader(work, viewer), visibleRecords: records => this.boundary.visible(records) };
  }
  async targets(targets: readonly string[]) {
    if (!targets.length) return [];
    const summaries: Array<Available | null> = [];
    for (let at = 0; at < targets.length; at += 50) {
      const batch = await readResourceSummaries(this.work.environment, this.work.media?.store, this.reader,
      { resources: targets.slice(at,at + 50), context: DEFAULT_MEDIA_CONTEXT, language: null, includeCollections: true,
        languages: readerLanguages(this.request.headers.get('x-rezics-display-languages'),
          this.request.headers.get('accept-language')) });
    if (batch.generation.graph !== `${this.position.dataEpoch}:${this.position.sequence}`) {
      throw new WorkReadMoved('Zone population changed during the read');
    }
      for (const summary of batch.summaries) {
        const available = summary.status === 'available' ? summary : null;
        this.summaries.set(summary.reference,available);
        summaries.push(available);
      }
    }
    return summaries;
  }
  async target(target: string) {
    if (!this.summaries.has(target)) this.summaries.set(target, (await this.targets([target]))[0] ?? null);
    return this.summaries.get(target)!;
  }
  async zone(state: Publication) {
    const current = await this.work.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?spaceDisclosure WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(state.zone)} a rv:Zone ; rv:zoneState rv:Active ;
        rv:zoneHead ${iri(state.currentRevision)} ; rv:disclosure rv:${state.storedDisclosure === 'public' ? 'Public' : 'Private'} ;
        rv:space ${iri(state.configuration.space)} .
        ${iri(state.configuration.space)} a rv:Space ; rv:disclosure ?spaceDisclosure . }
    } LIMIT 2`, 1024);
    const rows = current.results?.bindings ?? [];
    if (rows.length !== 1 || ![RV + 'Public',RV + 'Private'].includes(rows[0]?.spaceDisclosure?.value ?? '')) {
      throw new ZoneRouteMissing('Zone route is unavailable');
    }
    if (rows[0]!.spaceDisclosure!.value !== RV + 'Public' || state.storedDisclosure !== 'public') {
      await this.privateZone(state.zone);
      this.privateZones.add(state.zone);
    }
  }
  async privateZone(zone: string) {
    try { await readZoneVisibility(this.scopeSession, zone); }
    catch (error) {
      if (error instanceof WorkReadMissing) throw new ZoneRouteMissing('Zone route is unavailable');
      throw error;
    }
  }
  async semantic(resource: string) {
    if (!await this.reader.canReadSemantic?.(resource)) {
      throw new ZoneRouteMissing('Zone route is unavailable');
    }
    this.requiredSemantics.add(resource);
  }
}

/** All probes and hydration share one request budget. The position fence also
 * prevents a removed mount/member or changed disclosure from surviving hydration. */
async function boundedRead<T>(work: MainWorkDependencies, request: Request, actingSubject: string | undefined,
  operation: (read: RouteRead) => Promise<T>): Promise<T> {
  const outer = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(ZONE_ROUTE_COST.deadlineMs);
  const signal = outer ? AbortSignal.any([outer.signal, deadline]) : deadline;
  let calls: number = ZONE_ROUTE_COST.maxGraphReads, bytes: number = ZONE_ROUTE_COST.maxGraphBytes;
  const budget = { signal,
    get callsLeft() { return Math.min(calls, outer?.callsLeft ?? calls); },
    set callsLeft(value: number) { const used = this.callsLeft - value; calls -= used; if (outer) outer.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytes, outer?.bytesLeft ?? bytes); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytes -= used; if (outer) outer.bytesLeft -= used; },
  };
  try { return await fusekiReadBudget.run(budget, async () => {
    // Only read callbacks are replayed. All attempts share the same budget and
    // repeat scope, population and disclosure checks against fresh state.
    for (let attempt = 0; ; attempt++) {
      try {
        const before = await position(work);
        const viewer = await zoneRouteViewer(work, request, actingSubject);
        const read = new RouteRead(work, request, viewer, before);
        let result: T;
        try { result = await operation(read); }
        catch (error) {
          // A mount/head removed between probes is a moved read, not a stable 404.
          if (error instanceof ZoneRouteMissing && (await position(work)).sequence !== before.sequence) {
            throw new WorkReadMoved('Zone population changed during the read', { cause: error });
          }
          throw error;
        }
        for (const resource of read.requiredSemantics) await read.semantic(resource);
        for (const zone of read.privateZones) await read.privateZone(zone);
        try { await read.scopeSession.fenceRealms(); }
        catch (error) {
          if (error instanceof WorkReadMissing) throw new ZoneRouteMissing('Zone route is unavailable');
          throw error;
        }
        await read.boundary.fence();
        const after = await position(work);
        if (before.sequence !== after.sequence) throw new WorkReadMoved('Zone population changed during the read');
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (!(error instanceof WorkReadMoved || error instanceof SearchSnapshotMoved)
          || error instanceof WorkReadExpired) throw error;
        if (attempt + 1 === WORK_READ_COST.attempts) {
          throw new WorkReadUnavailable('A consistent Zone read could not be obtained within its budget', { cause: error });
        }
        await delay(Math.min(WORK_READ_COST.retryDelayMs * 2 ** attempt,
          WORK_READ_COST.maximumRetryDelayMs), undefined, { signal });
      }
    }
  }); } catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) {
      throw new WorkReadLimit('Zone read budget exceeded');
    }
    if (signal.aborted) throw new WorkReadUnavailable('Zone route deadline exceeded');
    throw error;
  }
}

async function navigationHeader(read: RouteRead, state: Publication) {
  const header = await readCompositionHeader(read.work.environment, state.configuration.navigation);
  if (!header || header.profile !== 'zone-navigation' || header.owner !== state.zone) {
    throw new ZoneRouteMissing('Zone route is unavailable');
  }
  return header;
}

/** ≤50 public mounts in immutable Structure order. Target names use the same
 * current disclosure reader as routes, including localized Collection names. */
export function readZonePresentation<T>(work: MainWorkDependencies, request: Request,
  zone: string, actingSubject: string | undefined,
  present: (state: Publication, navigation: ZoneNavigationItem[], viewer: ZoneRouteViewer) => Promise<T>) {
  return boundedRead(work, request, actingSubject, async read => {
    const state = await readZonePublication(work.environment, zone);
    await read.zone(state);
    if (state.documentSite && !state.bundle) return present(state, [], read.viewer);
    const header = await navigationHeader(read, state);
    const page = await readVisibleCompositionPage(work.environment, { structure: header.structure, header,
      ...(state.bundle ? { revision: state.bundle.navigationRevision } : {}),
      limit: ZONE_ROUTE_COST.maxNavigation,
      canReadTarget: async target => {
        const summary = await read.target(target);
        return summary?.type === 'collection' || summary?.type === 'work';
      },
      visible: item => item.role === 'mount' && !!item.target && item.qualifier?.type === 'zone-mount'
        && item.qualifier.zone === state.zone && item.qualifier.disclosure === 'public' });
    const items: ZoneNavigationItem[] = [];
    for (const item of page.occurrences) {
      const summary = await read.target(item.target!);
      const qualifier = item.qualifier;
      if (!summary || qualifier?.type !== 'zone-mount') continue;
      items.push({ occurrence: item.occurrence, segment: qualifier.routeSegment, target: item.target!,
        kind: summary.type === 'collection' ? 'index' : 'document', name: summary.name });
    }
    await read.targets([...new Set(items.map(item => item.target))]);
    return present(await visibleZonePresentation(read, state),
      items.filter(item => read.summaries.get(item.target)), read.viewer);
  });
}

async function visibleZonePresentation(read: RouteRead, state: Publication): Promise<Publication> {
  const currentSlides = state.presentation.slides.filter(slide => slideIsCurrent(slide));
  await read.targets([...new Set(currentSlides.flatMap(slide => 'work' in slide ? [slide.work] : []))]);
  const slides = currentSlides.filter(slide => !('work' in slide) || read.summaries.get(slide.work)?.type === 'work');
  return { ...state, presentation: { ...state.presentation, slides } };
}

async function mountAt(read: RouteRead, state: Publication, header: CompositionHeader, segment: string) {
  if (state.bundle) {
    // The current projection is an editor's draft. Resolve the retained route
    // qualifiers from the immutable publication, then apply current disclosure.
    const page = await readVisibleCompositionPage(read.work.environment, { structure: header.structure, header,
      revision: state.bundle.routesRevision, limit: ZONE_ROUTE_COST.mountRows,
      canReadTarget: async () => true,
      visible: item => item.role === 'mount' && !!item.target && item.qualifier?.type === 'zone-mount'
        && item.qualifier.zone === state.zone && item.qualifier.routeSegment === segment });
    const mount = page.occurrences[0];
    const qualifier = mount?.qualifier;
    if (page.next || page.occurrences.length !== 1 || !mount?.target || qualifier?.type !== 'zone-mount') {
      throw new ZoneRouteMissing('Zone route is unavailable');
    }
    if (qualifier.disclosure !== 'public') await read.semantic(state.zone);
    return { occurrence: mount.occurrence, target: mount.target, segment, key: qualifier.key ?? 'id' };
  }
  const rows = (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?occurrence ?target ?disclosure ?key WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(header.structure)} rv:structureHead ${iri(header.head)} ; rv:selectedGeneration ${iri(header.generation)} .
      ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
        rv:occurrence ?occurrence ; rv:occurrenceRole rv:MountRole ; schema:item ?target ; rv:qualifier ?q .
      ?q a rv:ZoneMount ; rv:zone ${iri(state.zone)} ; rv:routeSegment ${lit(segment)} ; rv:disclosure ?disclosure .
      OPTIONAL { ?q rv:routeKey ?key }
      FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
    } } LIMIT 2`, 8192)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.occurrence || !row.target || !row.disclosure
    || ![`${RV}Public`, `${RV}Private`].includes(row.disclosure.value)) {
    throw new ZoneRouteMissing('Zone route is unavailable');
  }
  if (row.disclosure.value !== `${RV}Public`) await read.semantic(state.zone);
  return { occurrence: row.occurrence.value, target: row.target.value, segment,key: row.key?.value === 'alias' ? 'alias' as const : 'id' as const };
}

async function resourceTypes(read: RouteRead, target: string): Promise<ResourceBinding> {
  return (await resourceTypeBatch(read,[target])).get(target)!;
}

/** One type query for the page, with per-member skew guards. Names come from
 * the same position-aware summary batch that admitted membership. */
async function resourceTypeBatch(read: RouteRead, targets: readonly string[]) {
  const result = new Map<string,ResourceBinding>();
  if (!targets.length) return result;
  const limit = targets.length * ZONE_ROUTE_COST.typeRowsPerResource;
  const rows = (await read.work.environment.fuseki.query(`SELECT DISTINCT ?resource ?type WHERE {
    VALUES ?resource { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?resource a ?type }
  } ORDER BY STR(?resource) STR(?type) LIMIT ${limit + 1}`, 64 * 1024)).results?.bindings ?? [];
  if (rows.length > limit) throw new WorkReadUnavailable('Zone resource types exceed their bound');
  for (const target of targets) {
    const found = rows.filter(row => row.resource?.value === target);
    if (found.length > ZONE_ROUTE_COST.typeRowsPerResource || !found.length || found.some(row => !row.type)) {
      throw new WorkReadUnavailable('Zone resource types exceed their bound');
    }
    const summary = await read.target(target);
    if (!summary) throw new ZoneRouteMissing('Zone route is unavailable');
    result.set(target,{ id: target,types: found.map(row => row.type!.value),name: summary.name,address: summary.address });
  }
  return result;
}

async function collectionHeader(read: RouteRead, collection: string) {
  const rows = (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?structure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} a rv:Collection ; rv:collectionState rv:Active ;
      rv:structure ?structure } } LIMIT 2`, 4096)).results?.bindings ?? [];
  const header = rows.length === 1 && rows[0]?.structure
    ? await readCompositionHeader(read.work.environment, rows[0].structure.value) : null;
  if (!header || header.profile !== 'collection-membership' || header.owner !== collection) {
    throw new ZoneRouteMissing('Zone route is unavailable');
  }
  return header;
}

/** One exact ASK, independent of Collection size. Tombstones, group targets and
 * placements in a staged/old generation cannot establish population membership. */
async function collectionMember(read: RouteRead, header: CompositionHeader, resource: string) {
  return (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    ASK { ${collectionPopulation(iri(header.structure), iri(header.head),
      iri(header.generation), iri(resource))} }`, 1024)).boolean === true;
}

/** The exact Work's current public Realm selection, never a browse window. */
async function publiclyAdopted(read: RouteRead, realm: string, resource: string) {
  return (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    ASK { ${realmPopulation(realm, iri(resource))} }`, 1024)).boolean === true;
}

async function indexItems(read: RouteRead, targets: string[]): Promise<Array<WorkCard | ResourceBinding>> {
  const summaries = targets.map(target => read.summaries.get(target) ?? null);
  const resources = await resourceTypeBatch(read,[...new Set(targets.filter((_,index) => summaries[index]?.type !== 'work'))]);
  const works = [...new Set(targets.filter((_, index) => summaries[index]?.type === 'work'))];
  const rows: Row[] = works.length ? (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?work ?head ?main ?type WHERE {
      VALUES ?work { ${works.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head ; rv:mainVersion ?main .
        OPTIONAL { ?work a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } } }
    } LIMIT ${works.length * 8 + 1}`, 64 * 1024)).results?.bindings ?? [] : [];
  if (rows.length > works.length * 8) throw new WorkReadUnavailable('Zone Work card types exceed their bound');
  const session = new WorkReadSession(read.work, read.request, {}, read.position);
  session.principal = read.viewer.principal;
  const serial = await readSerialSummaries(session, works.slice(0, 20));
  for (let at = 20; at < works.length; at += 20) {
    for (const [id, value] of await readSerialSummaries(session, works.slice(at, at + 20))) serial.set(id, value);
  }
  const result: Array<WorkCard | ResourceBinding> = [];
  for (const [index, target] of targets.entries()) {
    const summary = summaries[index];
    if (!summary) continue;
    if (summary.type !== 'work') { result.push(resources.get(target)!); continue; }
    const found = rows.filter(row => row.work?.value === target);
    const row = found[0];
    if (!row?.head || !row.main || found.some(value =>
      value.head?.value !== row.head!.value || value.main?.value !== row.main!.value)) {
      throw new WorkReadUnavailable('Zone Work card basis is ambiguous');
    }
    result.push({ id: target, revision: row.head.value, mainVersion: row.main.value,
      title: summary.name, cover: summary.avatar, types: found.flatMap(value => value.type ? [value.type.value] : []).sort(),
      ...serial.get(target)! });
  }
  return result;
}

export async function resolveZoneRoute(work: MainWorkDependencies, request: Request,
  input: { zone: string; path: string; cursor?: string; actingSubject?: string }): Promise<ZoneRoute> {
  const path = parseZonePath(input.path);
  if (!path) throw new ZoneRouteMissing('Zone route is unavailable');
  return boundedRead(work, request, input.actingSubject, async read => {
    let state: Publication;
    try { state = await readZonePublication(work.environment, input.zone); }
    catch (error) { if (error instanceof ZoneUnavailable) throw new ZoneRouteMissing('Zone route is unavailable'); throw error; }
    await read.zone(state);
    const basis: RouteBasis = { profile: 'zone-route-v1', zone: input.zone, path: input.path,
      name: state.name, language: state.language, direction: state.direction,
      listing: state.listing, discovery: state.discovery,
      realm: state.realm, revision: state.revision, sourcePosition: read.position, cost: ZONE_ROUTE_COST };
    if (state.documentSite && !state.bundle && path.kind !== 'home') {
      throw new ZoneRouteMissing('Zone site has not been published');
    }
    if (path.kind === 'home') {
      const page = await readZoneHomeDocument(work, request, await visibleZonePresentation(read, state));
      return { ...basis, kind: 'home', ...(page ? { page } : {}) };
    }
    if (path.kind === 'work') {
      const resource = `https://rezics.com/id/${path.resource}`;
      if (!state.realm || !await publiclyAdopted(read, state.realm, resource)
        || (await read.target(resource))?.disclosure !== 'public'
        || (await read.target(resource))?.type !== 'work') throw new ZoneRouteMissing('Zone route is unavailable');
      return { ...basis, kind: 'detail', mount: null, collection: null,
        resource: await resourceTypes(read, resource), tab: path.tab };
    }
    const navigation = await navigationHeader(read, state);
    const mount = await mountAt(read, state, navigation, path.segment);
    const summary = await read.target(mount.target);
    if (summary?.type === 'work' && path.resource === null) {
      const resource = await resourceTypes(read, mount.target);
      if (!(await read.targets([mount.target]))[0]) throw new ZoneRouteMissing('Zone route is unavailable');
      return { ...basis, kind: 'document', mount, resource };
    }
    if (summary?.type !== 'collection') throw new ZoneRouteMissing('Zone route is unavailable');
    const header = await collectionHeader(read, mount.target);
    if (path.resource !== null) {
      const uuid = identityKeyUuid(path.resource);
      const identified = uuid ? { holder: `https://rezics.com/id/${uuid}`,alias: null }
        : mount.key === 'alias' ? await work.environment.addresses?.identify(`zone:${state.configuration.space}`,path.resource) : null;
      if (!identified?.holder) throw new ZoneRouteMissing('Zone route is unavailable');
      const resource = identified.holder;
      if (!await collectionMember(read, header, resource) || !await read.target(resource)) {
        throw new ZoneRouteMissing('Zone route is unavailable');
      }
      if (identified.alias?.state === 'retired') throw new ZoneRouteRetired('Zone title is retired');
      const binding = await resourceTypes(read, resource);
      const aliases = work.environment.addresses;
      const spaceKey = (await canonicalAddresses(work.environment,[{ reference: state.configuration.space,
        type: 'space',name: { value: state.name ?? '' } }])).get(state.configuration.space)!.key;
      const routeAlias = mount.key === 'alias' && aliases ? (await aliases.pool.query<{ key: string }>(`SELECT key FROM access.alias_registry
        WHERE scope = $1 AND holder = $2 AND state = 'current'`, [`zone:${state.configuration.space}`,resource])).rows[0]?.key : null;
      binding.address = { prefix: `/z/${spaceKey}/${mount.segment}/`,key: routeAlias ?? uuidToSid(resource.slice(-36)),
        suffixSource: (await read.target(resource))?.disclosure === 'public' ? binding.name.value : '' };
      const fenced = await read.targets([mount.target, resource]);
      if (fenced.some(target => !target)) throw new ZoneRouteMissing('Zone route is unavailable');
      return { ...basis, kind: 'detail', mount, collection: mount.target, resource: binding, tab: path.tab };
    }
    // Unrelated graph writes do not expire an immutable membership continuation.
    // A changed Collection head or recovery epoch still requires a fresh page.
    const binding = ['zone-route-v1', input.zone, input.path, input.actingSubject ?? null,
      mount.target, header.structure, await read.boundary.binding(),
      ...(state.bundle ? [state.bundle.routesRevision] : [])];
    const collectionPosition = { dataEpoch: read.position.dataEpoch, sequence: header.head };
    const cursor = decodeReadCursor(input.cursor, binding, collectionPosition);
    const page = await readVisibleCompositionPage(work.environment, { structure: header.structure, header,
      ...(cursor ? { after: cursor.after } : {}), limit: ZONE_ROUTE_COST.pageSize,
      canReadTarget: async target => !!await read.target(target),
      canReadTargets: async targets => new Set((await read.targets(targets))
        .flatMap(summary => summary ? [summary.reference] : [])),
      visible: item => item.role === 'member' && !!item.target && NATIVE_ID.test(item.target) });
    const cards = await indexItems(read, page.occurrences.map(item => item.target!));
    const members = await readZonePopulation(async query =>
      (await work.environment.fuseki.query(query, ZONE_POPULATION_COST.graphBytes)).results?.bindings ?? [],
    { collection: header }, cards.map(card => card.id));
    const items = cards.map(card => ({ ...card, inZone: members.has(card.id) }));
    const fenced = await read.targets([mount.target, ...items.map(item => item.id)]);
    if (!fenced[0]) throw new ZoneRouteMissing('Zone route is unavailable');
    return { ...basis, kind: 'index', mount, collection: mount.target,
      items: items.filter((_, index) => fenced[index + 1] !== null),
      nextCursor: page.next ? encodeReadCursor(binding, collectionPosition, page.next) : null };
  });
}
