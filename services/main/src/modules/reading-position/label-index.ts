import { GRAPHS, iri, lit } from '../work/activate.ts';
import { NATIVE_ID, placementIri } from '../structure/graph.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { ReadingOccurrence } from './boundary.ts';
import type { ReadingWork } from './traversal.ts';
import type { ReadingOrderIndex } from './immutable-order.ts';

/** The native directory seeks exact normalized substring postings before its
 * limit. It also returns navigation roles, so depth-first traversal can enter
 * groups and composed Works without scanning unrelated chapter labels. */
export const OCCURRENCE_SEARCH_COST = { keyChars: 134, probe: 101, directories: 2 } as const;
export async function searchOccurrenceLabels(session: WorkReadSession, order: ReadingOrderIndex,
  meta: ReadingWork, parent: string, q: string, after: ReadingOccurrence | undefined,
  limit: number, numbered: string | null): Promise<Array<{ item: ReadingOccurrence; matches: boolean }>> {
  const afterKey = after ? `${after.segmentKey}\u0001${after.orderKey}\u0001${after.occurrence}` : '';
  const rows = await session.query(`# reading-position:label-index
    SELECT ?page WHERE { BIND(rv:occurrenceSearch(${iri(meta.generation!)}, ${iri(parent)},
      ${lit(q)}, ${lit(afterKey)}, ${limit}) AS ?page) } LIMIT 1`, 1);
  let page: unknown;
  try { page = JSON.parse(rows[0]?.page?.value ?? ''); }
  catch { throw new WorkReadUnavailable('Occurrence label index is unavailable; run its backfill'); }
  const result = page as { items?: Array<{ occurrence: string; segmentKey: string; orderKey: string; matches: boolean }>; reads?: number };
  if (!result || !Array.isArray(result.items) || result.items.length > limit || !Number.isSafeInteger(result.reads)
    || result.reads! < 0 || result.reads! > (limit + 1) * (OCCURRENCE_SEARCH_COST.keyChars + 1) * OCCURRENCE_SEARCH_COST.directories) {
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
  if (numbered && !entries.some(entry => entry.occurrence === numbered)) {
    // Numeric sibling rank is another exact counted-tree seek. Bind its
    // placement identity; this is never an OFFSET or a label inventory read.
    const records = await session.query(`# reading-position:numbered-placement
      SELECT ?segmentKey ?orderKey WHERE { GRAPH ${iri(GRAPHS.current)} {
        BIND(${iri(placementIri(meta.generation!, numbered))} AS ?placement)
        ?placement rv:generation ${iri(meta.generation!)} ; rv:occurrence ${iri(numbered)} ;
          rv:orderSegment ?segment ; rv:orderKey ?orderKey .
        ?segment rv:parent ${iri(parent)} ; rv:segmentKey ?segmentKey .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
      } } LIMIT 2`, 2);
    if (records.length !== 1 || !records[0]?.segmentKey || !records[0]?.orderKey) {
      throw new WorkReadUnavailable('Numbered placement is unavailable');
    }
    const entry = { parent, occurrence: numbered, segmentKey: records[0].segmentKey.value,
      orderKey: records[0].orderKey.value, matches: true };
    if (key(entry) > afterKey) entries.push(entry);
  }
  entries.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  entries.splice(limit);
  const matches = new Set(entries.filter(entry => entry.matches || entry.occurrence === numbered).map(entry => entry.occurrence));
  const items = await order.hydrate(meta, entries, true);
  return items.map(item => ({ item, matches: matches.has(item.occurrence) }));
}
