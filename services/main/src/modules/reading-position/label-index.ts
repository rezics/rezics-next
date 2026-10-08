import { GRAPHS, iri, lit } from '../work/activate.ts';
import { NATIVE_ID, placementIri } from '../structure/graph.ts';
import { assertPublicTextReady } from '../work/search-readiness.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { ReadingOccurrence } from './boundary.ts';
import type { ReadingWork } from './traversal.ts';
import type { ReadingOrderIndex } from './immutable-order.ts';

/** Lucene seeks analyzed labels and navigation roles under one selected
 * revision. A pending projection yields a bounded partial page, never a scan. */
const readiness = new WeakMap<WorkReadSession, Promise<unknown>>();
export const OCCURRENCE_SEARCH_COST = { keyChars: 134, normalizedQueryChars: 4000, probe: 101, directories: 2, visits: 4096 } as const;
export async function searchOccurrenceLabels(session: WorkReadSession, order: ReadingOrderIndex,
  meta: ReadingWork, parent: string, q: string, after: ReadingOccurrence | undefined,
  limit: number, numbered: string | { occurrence: string; segmentKey: string; orderKey: string } | null): Promise<{ candidates: Array<{ item: ReadingOccurrence; matches: boolean }>; current: boolean }> {
  if (session.deps?.environment) {
    if (!readiness.has(session)) readiness.set(session,
      assertPublicTextReady(session.deps.environment.fuseki, session.deps.environment.lineage));
    await readiness.get(session);
  }
  const afterKey = after ? `${after.segmentKey}\u0001${after.orderKey}\u0001${after.occurrence}` : '';
  const rows = await session.query(`# reading-position:label-index
    SELECT ?page WHERE { BIND(rv:occurrenceSearch(${iri(meta.generation!)}, ${iri(parent)},
      ${lit(q)}, ${lit(afterKey)}, ${limit}) AS ?page) } LIMIT 1`, 1);
  let page: unknown;
  try { page = JSON.parse(rows[0]?.page?.value ?? ''); }
  catch { throw new WorkReadUnavailable('Occurrence label index is unavailable; run its backfill'); }
  const result = page as { items?: Array<{ occurrence: string; segmentKey: string; orderKey: string; matches: boolean }>; reads?: number; current?: boolean };
  if (!result || !Array.isArray(result.items) || result.items.length > limit || !Number.isSafeInteger(result.reads)
    || result.reads! < 0 || result.reads! > OCCURRENCE_SEARCH_COST.visits || typeof result.current !== 'boolean') {
    throw new WorkReadUnavailable('Occurrence label index page exceeds its cost');
  }
  const key = (entry: { segmentKey: string; orderKey: string; occurrence: string }) =>
    `${entry.segmentKey}\u0001${entry.orderKey}\u0001${entry.occurrence}`;
  let previous = afterKey;
  for (const item of result.items) {
    if (!item || typeof item.occurrence !== 'string' || typeof item.segmentKey !== 'string'
      || typeof item.orderKey !== 'string' || !NATIVE_ID.test(item.occurrence) || !/^[0-9a-z]{1,32}$/.test(item.segmentKey)
      || !/^[0-9a-z]{1,32}$/.test(item.orderKey) || typeof item.matches !== 'boolean' || key(item) <= previous) {
      throw new WorkReadUnavailable('Occurrence label index order is invalid');
    }
    previous = key(item);
  }
  const entries = result.items.map(entry => ({ ...entry, parent }));
  const numberedOccurrence = typeof numbered === 'string' ? numbered : numbered?.occurrence ?? null;
  if (numberedOccurrence && !entries.some(entry => entry.occurrence === numberedOccurrence)) {
    // The counted tree already names this sibling's keys. A graph placement
    // read is only the fallback when the caller has the occurrence alone.
    let segmentKey: string | undefined, orderKey: string | undefined;
    if (numbered && typeof numbered !== 'string') {
      segmentKey = numbered.segmentKey;
      orderKey = numbered.orderKey;
    } else {
      const records = await session.query(`# reading-position:numbered-placement
        SELECT ?segmentKey ?orderKey WHERE { GRAPH ${iri(GRAPHS.current)} {
          BIND(${iri(placementIri(meta.generation!, numberedOccurrence))} AS ?placement)
          ?placement rv:generation ${iri(meta.generation!)} ; rv:occurrence ${iri(numberedOccurrence)} ;
            rv:orderSegment ?segment ; rv:orderKey ?orderKey .
          ?segment rv:parent ${iri(parent)} ; rv:segmentKey ?segmentKey .
          FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
        } } LIMIT 2`, 2);
      if (records.length !== 1 || !records[0]?.segmentKey || !records[0]?.orderKey) {
        throw new WorkReadUnavailable('Numbered placement is unavailable');
      }
      segmentKey = records[0].segmentKey.value;
      orderKey = records[0].orderKey.value;
    }
    const entry = { parent, occurrence: numberedOccurrence, segmentKey, orderKey, matches: true };
    if (key(entry) > afterKey) entries.push(entry);
  }
  entries.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  entries.splice(limit);
  const matches = new Set(entries.filter(entry => entry.matches || entry.occurrence === numberedOccurrence).map(entry => entry.occurrence));
  const items = await order.hydrate(meta, entries, true);
  return { candidates: items.map(item => ({ item, matches: matches.has(item.occurrence) })), current: result.current };
}
