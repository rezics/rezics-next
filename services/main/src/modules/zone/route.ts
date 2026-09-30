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
  WorkReadExpired, WorkReadLimit, WorkReadUnavailable, publicWork, type ReadPosition } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import type { WorkCard } from '../work/read-header.ts';
import { readZonePublication } from './publication.ts';
import { ZoneUnavailable } from './configuration.ts';
import { parseZonePath } from './route-path.ts';
import { ZONE_ROUTE_COST } from './route-cost.ts';
export { ZONE_ROUTE_COST } from './route-cost.ts';

export class ZoneRouteMissing extends Error {}
type Publication = Awaited<ReturnType<typeof readZonePublication>>;
type Available = Extract<ResourceSummary, { status: 'available' }>;
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
export interface ZoneMountBinding { occurrence: string; segment: string; target: string }
export interface ZoneNavigationItem extends ZoneMountBinding {
  kind: 'document' | 'index'; name: Available['name'];
}
interface ResourceBinding { id: string; types: string[] }
interface RouteBasis { profile: 'zone-route-v1'; zone: string; path: string;
  name: Publication['name']; language: string; direction: Publication['direction'];
  realm: string | null; revision: string; sourcePosition: ReadPosition; cost: typeof ZONE_ROUTE_COST }
export type ZoneRoute = RouteBasis & (
  { kind: 'home' }
  | { kind: 'document'; mount: ZoneMountBinding; resource: ResourceBinding }
  | { kind: 'index'; mount: ZoneMountBinding; collection: string;
    items: Array<WorkCard | ResourceBinding>; nextCursor: string | null }
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
  readonly summaries = new Map<string, Available | null>();
  readonly requiredSemantics = new Set<string>();
  constructor(readonly work: MainWorkDependencies, readonly request: Request,
    readonly viewer: ZoneRouteViewer, readonly position: ReadPosition) {
    this.reader = summaryReader(work, viewer);
  }
  async targets(targets: readonly string[]) {
    if (!targets.length) return [];
    const batch = await readResourceSummaries(this.work.environment, this.work.media?.store, this.reader,
      { resources: targets, context: DEFAULT_MEDIA_CONTEXT, language: null, includeCollections: true,
        languages: readerLanguages(this.request.headers.get('x-rezics-display-languages'),
          this.request.headers.get('accept-language')) });
    if (batch.generation.graph !== `${this.position.dataEpoch}:${this.position.sequence}`) {
      throw new WorkReadMoved('Zone population changed during the read');
    }
    return batch.summaries.map(summary => summary.status === 'available' ? summary : null);
  }
  async target(target: string) {
    if (!this.summaries.has(target)) this.summaries.set(target, (await this.targets([target]))[0] ?? null);
    return this.summaries.get(target)!;
  }
  async zone(state: Publication) {
    const current = await this.work.environment.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(state.zone)} a rv:Zone ; rv:zoneState rv:Active ;
        rv:zoneHead ${iri(state.revision)} ; rv:disclosure rv:${state.disclosure === 'public' ? 'Public' : 'Private'} . }
    }`, 1024);
    if (current.boolean !== true) throw new ZoneRouteMissing('Zone route is unavailable');
    if (state.disclosure !== 'public') await this.semantic(state.zone);
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
    const header = await navigationHeader(read, state);
    const page = await readVisibleCompositionPage(work.environment, { structure: header.structure, header,
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
    const fenced = await read.targets(items.map(item => item.target));
    return present(state, items.filter((_, index) => fenced[index] !== null), read.viewer);
  });
}

async function mountAt(read: RouteRead, state: Publication, header: CompositionHeader, segment: string) {
  const rows = (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?occurrence ?target ?disclosure WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(header.structure)} rv:structureHead ${iri(header.head)} ; rv:selectedGeneration ${iri(header.generation)} .
      ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
        rv:occurrence ?occurrence ; rv:occurrenceRole rv:MountRole ; schema:item ?target ; rv:qualifier ?q .
      ?q a rv:ZoneMount ; rv:zone ${iri(state.zone)} ; rv:routeSegment ${lit(segment)} ; rv:disclosure ?disclosure .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
    } } LIMIT 2`, 8192)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.occurrence || !row.target || !row.disclosure
    || ![`${RV}Public`, `${RV}Private`].includes(row.disclosure.value)) {
    throw new ZoneRouteMissing('Zone route is unavailable');
  }
  if (row.disclosure.value !== `${RV}Public`) await read.semantic(state.zone);
  return { occurrence: row.occurrence.value, target: row.target.value, segment };
}

async function resourceTypes(read: RouteRead, target: string): Promise<ResourceBinding> {
  const rows = (await read.work.environment.fuseki.query(`SELECT DISTINCT ?type WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(target)} a ?type }
  } ORDER BY STR(?type) LIMIT ${ZONE_ROUTE_COST.typeRowsPerResource + 1}`, 8192)).results?.bindings ?? [];
  if (rows.length > ZONE_ROUTE_COST.typeRowsPerResource || rows.some(row => !row.type)) {
    throw new WorkReadUnavailable('Zone resource types exceed their bound');
  }
  return { id: target, types: rows.map(row => row.type!.value) };
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
    ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(header.structure)} rv:structureHead ${iri(header.head)} ; rv:selectedGeneration ${iri(header.generation)} .
      ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
        rv:occurrenceRole rv:MemberRole ; schema:item ${iri(resource)} .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    } }`, 1024)).boolean === true;
}

/** The exact Work's current public Realm selection, never a browse window. */
async function publiclyAdopted(read: RouteRead, realm: string, resource: string) {
  return (await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ${iri(resource)} ;
          rv:mainVersion ?main ; rv:selectionHead ?selection .
        ?contribution rv:publicationHead ?decision . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:component ?slot ;
        rv:context ${iri(realm)} ; rv:work ${iri(resource)} ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
        ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      ${publicWork(iri(resource), '?main')}
    }`, 1024)).boolean === true;
}

async function indexItems(read: RouteRead, targets: string[]): Promise<Array<WorkCard | ResourceBinding>> {
  const summaries = await read.targets(targets);
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
    if (summary.type !== 'work') { result.push(await resourceTypes(read, target)); continue; }
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
      realm: state.realm, revision: state.revision, sourcePosition: read.position, cost: ZONE_ROUTE_COST };
    if (path.kind === 'home') return { ...basis, kind: 'home' };
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
      const resource = `https://rezics.com/id/${path.resource}`;
      if (!await collectionMember(read, header, resource) || !await read.target(resource)) {
        throw new ZoneRouteMissing('Zone route is unavailable');
      }
      const binding = await resourceTypes(read, resource);
      const fenced = await read.targets([mount.target, resource]);
      if (fenced.some(target => !target)) throw new ZoneRouteMissing('Zone route is unavailable');
      return { ...basis, kind: 'detail', mount, collection: mount.target, resource: binding, tab: path.tab };
    }
    // Unrelated graph writes do not expire an immutable membership continuation.
    // A changed Collection head or recovery epoch still requires a fresh page.
    const binding = ['zone-route-v1', input.zone, input.path, input.actingSubject ?? null,
      mount.target, header.structure];
    const collectionPosition = { dataEpoch: read.position.dataEpoch, sequence: header.head };
    const cursor = decodeReadCursor(input.cursor, binding, collectionPosition);
    const page = await readVisibleCompositionPage(work.environment, { structure: header.structure, header,
      ...(cursor ? { after: cursor.after } : {}), limit: ZONE_ROUTE_COST.pageSize,
      canReadTarget: async target => !!await read.target(target),
      visible: item => item.role === 'member' && !!item.target && NATIVE_ID.test(item.target) });
    const items = await indexItems(read, page.occurrences.map(item => item.target!));
    const fenced = await read.targets([mount.target, ...items.map(item => item.id)]);
    if (!fenced[0]) throw new ZoneRouteMissing('Zone route is unavailable');
    return { ...basis, kind: 'index', mount, collection: mount.target,
      items: items.filter((_, index) => fenced[index + 1] !== null),
      nextCursor: page.next ? encodeReadCursor(binding, collectionPosition, page.next) : null };
  });
}
