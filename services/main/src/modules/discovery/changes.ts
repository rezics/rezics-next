import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadLimit, type WorkReadSession } from '../work/read-session.ts';
import { FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';

export const DISCOVERY_DELTA_COST = { batches: 1000, events: 2000 } as const;
// These commands only change their named Work's discovery inputs. Definition,
// classification, protection, structure and unknown commands require a rebuild.
const localActions = new Set(['work.create', 'work.edit', 'contribution.create',
  'contribution.publish', 'publication.select']);
export interface DiscoveryChanges { works: string[]; created: string[] }

/** Exact contiguous outbox coverage, never a best-effort list of changed Works.
 * A retention gap, malformed batch or an unclassified event disables reuse. */
export async function discoveryChanges(session: WorkReadSession, after: string): Promise<DiscoveryChanges | null> {
  const count = BigInt(session.position.sequence) - BigInt(after);
  if (count === 0n) return { works: [], created: [] };
  if (count < 0n || count > BigInt(DISCOVERY_DELTA_COST.batches)) return null;
  const rows = await session.query(`SELECT ?batch ?sequence ?count ?event ?ordinal ?action ?work WHERE {
    VALUES ?sequence { ${Array.from({ length: Number(count) }, (_, i) => BigInt(after) + BigInt(i + 1)).join(' ')} }
    GRAPH ${iri(GRAPHS.outbox)} {
      ?batch a rv:OutboxBatch ; rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence ; rv:eventCount ?count .
      OPTIONAL { ?batch rv:event ?event .
        OPTIONAL { ?event rv:ordinal ?ordinal ; rv:action ?action ; rv:work ?work } }
    }
  } LIMIT ${DISCOVERY_DELTA_COST.events + 1}`, DISCOVERY_DELTA_COST.events + 1).catch(error => {
    // A dense interval falls back to bounded source pages; it must not retry
    // the same oversized delta forever after writers have become idle.
    if (error instanceof WorkReadLimit || error instanceof FusekiQueryResponseTooLarge) return null;
    throw error;
  });
  if (!rows || rows.length > DISCOVERY_DELTA_COST.events) return null;
  const batches = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.sequence || !row.batch || !row.count || !row.event || !row.ordinal || !row.action || !row.work
      || !localActions.has(row.action.value) || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.work.value)) return null;
    batches.set(row.sequence.value, [...(batches.get(row.sequence.value) ?? []), row]);
  }
  if (batches.size !== Number(count)) return null;
  for (const batch of batches.values()) {
    if (new Set(batch.map(row => row.batch!.value)).size !== 1
      || batch.some(row => Number(row.count!.value) !== batch.length)
      || new Set(batch.map(row => row.event!.value)).size !== batch.length
      || batch.map(row => Number(row.ordinal!.value)).sort((a, b) => a - b).some((value, i) => value !== i)) return null;
  }
  return { works: [...new Set(rows.map(row => row.work!.value))].sort(),
    created: [...new Set(rows.filter(row => row.action!.value === 'work.create').map(row => row.work!.value))].sort() };
}
