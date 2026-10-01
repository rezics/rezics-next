import { GRAPHS, iri, lit } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMissing,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

export type CollectionGrain = 'series' | 'parts';
export interface CollectionWork { work: string; mainVersion: string }

/** Logical bounds, not a claim about Jena's physical join plan. Candidate pairs
 * are ordered by Work then member, so repeated uses and shared parts collapse
 * across page boundaries. At most 64 distinct Works need summary hydration per
 * batch. Sparse scans share workRead's call/byte budget and deadline; exhaustion
 * fails the read, never returns a falsely complete prefix.
 * DISTINCT precedes LIMIT: https://www.w3.org/TR/sparql11-query/#modDistinct
 */
export const COLLECTION_GRAIN_COST = { page: 100, candidatePairs: 32,
  summaryTargets: 64, collectionQueries: 1, compositionLevels: 1 } as const;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export async function readCollectionGrain(session: WorkReadSession, collection: string,
  input: { grain: CollectionGrain; limit: number; cursor?: string }) {
  if (!native.test(collection) || !['series', 'parts'].includes(input.grain)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > COLLECTION_GRAIN_COST.page) {
    throw new WorkReadInvalid('Collection grain or page size is invalid');
  }
  const roots = await session.query(`SELECT ?structure ?revision ?generation ?disclosure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} a rv:Collection ;
      rv:collectionState rv:Active ; rv:structure ?structure ; rv:disclosure ?disclosure .
      ?structure a rv:Structure ; rv:structureOf ${iri(collection)} ;
        rv:structureProfile rv:CollectionMembership ; rv:structureHead ?revision ;
        rv:selectedGeneration ?generation . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} rv:protectionHead ?protection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
  } LIMIT 2`, 2);
  const root = roots[0];
  if (roots.length !== 1 || !root?.structure || !root.revision || !root.generation || !root.disclosure) {
    throw new WorkReadMissing('Collection is unavailable');
  }
  const publicCollection = root.disclosure.value === 'https://rezics.com/vocab/Public';
  const allowed = async () => {
    if (publicCollection) return true;
    if (!session.principal || !session.options.actingSubject) return false;
    const principal = await session.deps.account.verify(session.request, ['semantic:read']);
    return session.deps.access.canReadSemanticResource?.(principal, session.options.actingSubject, collection);
  };
  if (!await allowed()) throw new WorkReadMissing('Collection is unavailable');
  const binding = { kind: 'collection-grain-v1', collection, grain: input.grain,
    actor: session.options.actingSubject, issuer: session.principal?.issuer,
    subject: session.principal?.subject };
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  const afterWork = cursor?.after;
  const readable = new Map<string, boolean>();
  const items = new Map<string, CollectionWork>();
  // /collections/:id/works is deliberately a Work inventory: series and parts
  // return Work/MainVersion pairs, not the Collection's base-neutral members.
  // These candidate predicates retain that grain; summaries admit the audience.
  // ast-grep-ignore: capability-targets-use-resolver
  const memberWorks = publicWork('?member', '?memberMain');
  // ast-grep-ignore: capability-targets-use-resolver
  const catalogueWorks = publicWork('?work', '?main');
  let afterPair: string | undefined;
  while (true) {
    session.checkDeadline();
    const rows = await session.query(`SELECT DISTINCT ?work ?main ?member WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?membership a rv:OccurrencePlacement ; rv:generation ${iri(root.generation.value)} ;
          rv:occurrenceRole rv:MemberRole ; schema:item ?member .
        FILTER NOT EXISTS { ?membership rv:removedBy ?removed }
        ${input.grain === 'series' ? 'BIND(?member AS ?work)' : `
        ?parts a rv:Structure ; rv:structureOf ?memberMain ;
          rv:structureProfile rv:WorkComposition ; rv:selectedGeneration ?partsGeneration ;
          rv:structureHead ?partsRevision .
        ?part a rv:OccurrencePlacement ; rv:generation ?partsGeneration ; rv:composedWork ?work .
        FILTER NOT EXISTS { ?part rv:removedBy ?partRemoved }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?partsRevision a rv:ErasedRevision } }`}
        # Release identities never become catalogue Works, even in a mixed Collection.
        FILTER NOT EXISTS { ?work a rv:Release }
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?work a rv:FixedRelease } }
      ${memberWorks}
      ${catalogueWorks}
      BIND(CONCAT(STR(?work), "|", STR(?member)) AS ?key)
      ${afterWork ? `FILTER(STR(?work) > ${lit(afterWork)})` : ''}
      ${afterPair ? `FILTER(?key > ${lit(afterPair)})` : ''}
    } ORDER BY STR(?work) STR(?member) LIMIT ${COLLECTION_GRAIN_COST.candidatePairs}`,
    COLLECTION_GRAIN_COST.candidatePairs);
    const targets = [...new Set(rows.flatMap(row => [row.work?.value, row.member?.value]))];
    if (rows.some(row => !native.test(row.work?.value ?? '') || !native.test(row.main?.value ?? '')
      || !native.test(row.member?.value ?? ''))) throw new WorkReadUnavailable('Collection Work projection is invalid');
    const unchecked = targets.filter((target): target is string => !!target && !readable.has(target));
    if (unchecked.length) {
      const summaries = await session.summaries(unchecked);
      for (const summary of summaries) {
        readable.set(summary.reference, summary.status === 'available' && summary.type === 'work'
          && summary.disclosure === 'public');
      }
    }
    for (const row of rows) {
      const work = row.work!.value, mainVersion = row.main!.value;
      if (!readable.get(work) || !readable.get(row.member!.value)) continue;
      if (items.has(work) && items.get(work)!.mainVersion !== mainVersion) {
        throw new WorkReadUnavailable('Collection Work has ambiguous Main Versions');
      }
      items.set(work, { work, mainVersion });
      if (items.size > input.limit) break;
    }
    if (items.size > input.limit || rows.length < COLLECTION_GRAIN_COST.candidatePairs) break;
    const last = rows.at(-1)!;
    afterPair = `${last.work!.value}|${last.member!.value}`;
  }
  // A cursor never authorizes a Collection after its gate has closed.
  if (!await allowed()) throw new WorkReadMissing('Collection is unavailable');
  const disclosed = [...items.values()];
  const hasNext = disclosed.length > input.limit;
  disclosed.splice(input.limit);
  return { collection, grain: input.grain, structure: root.structure.value,
    revision: root.revision.value, order: 'work-id' as const, items: disclosed,
    nextCursor: hasNext ? encodeReadCursor(binding, session.position, disclosed.at(-1)!.work) : null,
    sourcePosition: { datasetId: 'product' as const, ...session.position } };
}
