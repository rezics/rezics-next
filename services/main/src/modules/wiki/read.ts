import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readVisibleCompositionPage } from '../collection/visible-page.ts';
import { readCompositionHeader, type CompositionHeader } from '../structure/graph.ts';
import { resolveTargets, targetRead, type TargetReadSession } from '../target/resolve.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { readZonePublication } from '../zone/publication.ts';
import { WikiRejected } from './errors.ts';

export const WIKI_READ_COST = { graphReads: 2048, graphBytes: 8_388_608, deadlineMs: 10_000,
  inventory: 512, pages: 64, targetBatch: 50 } as const;
export interface WikiRead { work: MainWorkDependencies; session: TargetReadSession;
  principal: VerifiedPrincipal; actingSubject: string }
export function wikiRead<T>(work: MainWorkDependencies, principal: VerifiedPrincipal, actingSubject: string,
  operation: (read: WikiRead) => Promise<T>) {
  if (work.structureObjects) (work.environment as typeof work.environment & {
    structureObjects: NonNullable<typeof work.structureObjects> }).structureObjects = work.structureObjects;
  return fusekiReadBudget.run({ signal: AbortSignal.timeout(WIKI_READ_COST.deadlineMs),
    callsLeft: WIKI_READ_COST.graphReads, bytesLeft: WIKI_READ_COST.graphBytes }, () =>
    targetRead(work.environment, { access: work.access, principal, actingSubject }, session =>
      operation({ work, session, principal, actingSubject })));
}
async function readableOwner(read: WikiRead, resource: string, type: string, state: string) {
  const rows = await read.session.query(`SELECT ?disclosure WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(resource)} a rv:${type} ; rv:${state} rv:Active ; rv:disclosure ?disclosure .
  } } LIMIT 2`, 2);
  if (rows.length !== 1 || !rows[0]?.disclosure || (rows[0].disclosure.value !== `${RV}Public`
    && !await read.work.access.canReadSemanticResource?.(read.principal, read.actingSubject, resource))) {
    throw new WikiRejected('wiki_unavailable', 404);
  }
}
export async function wikiScope(read: WikiRead, target: string, zone: string) {
  const [workTarget] = await resolveTargets(read.session, [target], 'collection-member');
  if (workTarget?.base !== 'work') throw new WikiRejected('wiki_target_mismatch');
  await readableOwner(read, zone, 'Zone', 'zoneState');
  const publication = await readZonePublication(read.work.environment, zone);
  const navigation = await readCompositionHeader(read.work.environment, publication.configuration.navigation);
  if (!navigation || navigation.owner !== zone || navigation.profile !== 'zone-navigation') {
    throw new WikiRejected('wiki_unavailable', 404);
  }
  const mounts = await read.session.query(`SELECT ?segment ?collection WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(navigation.structure)} rv:structureHead ${iri(navigation.head)} ; rv:selectedGeneration ${iri(navigation.generation)} .
    ?placement a rv:OccurrencePlacement ; rv:generation ${iri(navigation.generation)} ;
      rv:occurrenceRole rv:MountRole ; <https://schema.org/item> ?collection ; rv:qualifier ?q .
    ?q a rv:ZoneMount ; rv:zone ${iri(zone)} ; rv:routeSegment ?segment ; rv:disclosure rv:Public .
    FILTER(?segment IN ("franchise", "characters", "places", "events"))
    FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
  } } LIMIT 5`, 4);
  const collections = new Map<string, CompositionHeader>();
  for (const mount of mounts) {
    const segment = mount.segment?.value, collection = mount.collection?.value;
    if (!segment || !collection || collections.has(segment)) throw new WikiRejected('wiki_target_mismatch');
    await readableOwner(read, collection, 'Collection', 'collectionState');
    const rows = await read.session.query(`SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(collection)} rv:structure ?structure . } } LIMIT 2`, 2);
    const header = rows.length === 1 && rows[0]?.structure
      ? await readCompositionHeader(read.work.environment, rows[0].structure.value) : null;
    if (!header || header.profile !== 'collection-membership' || header.owner !== collection) {
      throw new WikiRejected('wiki_unavailable', 404);
    }
    collections.set(segment, header);
  }
  const franchise = collections.get('franchise');
  if (!franchise) throw new WikiRejected('wiki_target_mismatch');
  const member = await read.work.environment.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(franchise.structure)} rv:structureHead ${iri(franchise.head)} ; rv:selectedGeneration ${iri(franchise.generation)} .
    ?placement a rv:OccurrencePlacement ; rv:generation ${iri(franchise.generation)} ;
      rv:occurrenceRole rv:MemberRole ; <https://schema.org/item> ${iri(target)} .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
  } }`, 1024);
  if (member.boolean !== true) throw new WikiRejected('wiki_target_mismatch');
  return { target: workTarget, collections };
}

/** Read immutable Collection member records, including nested groups. This is a
 * trusted matching scan: unreadable members stay internal and are redacted by
 * the target resolver before returning any candidate metadata. A truncated
 * inventory fails explicitly; it can never turn an unseen match into `new`. */
export async function wikiMembers(read: WikiRead, collections: ReadonlyMap<string, CompositionHeader>) {
  const targets = new Set<string>();
  let records = 0, pages = 0;
  for (const [segment, header] of collections) {
    if (segment === 'franchise') continue;
    const queue: Array<{ parent: string; after?: string }> = [{ parent: header.structure }];
    while (queue.length) {
      if (++pages > WIKI_READ_COST.pages) throw new WikiRejected('wiki_query_budget');
      const scan = queue.shift()!;
      const page = await readVisibleCompositionPage(read.work.environment, { structure: header.structure, header,
        parent: scan.parent, after: scan.after, limit: 100, canReadTarget: async () => true,
        visible: item => item.role === 'member' || item.role === 'group' });
      records += page.occurrences.length;
      if (records > WIKI_READ_COST.inventory) throw new WikiRejected('wiki_query_budget');
      for (const item of page.occurrences) {
        if (item.role === 'group') queue.push({ parent: item.occurrence });
        else if (item.target) targets.add(item.target);
      }
      if (page.next) queue.unshift({ ...scan, after: page.next });
    }
  }
  return [...targets];
}
