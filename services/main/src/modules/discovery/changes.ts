import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadLimit, type WorkReadSession } from '../work/read-session.ts';
import { FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';
import { discoveryEventEffect, discoveryEventWorks } from './effects.ts';

export const DISCOVERY_DELTA_COST = { batches: 1000, events: 2000 } as const;
export interface DiscoveryChanges {
  works: string[];
  created: string[];
}

/** Exact contiguous outbox coverage, never a best-effort list of changed Works.
 * A retention gap, malformed batch or an unclassified event disables reuse. */
export async function discoveryChanges(
  session: WorkReadSession,
  after: string,
  basis?: OwnedDiscoveryBasis,
): Promise<DiscoveryChanges | null> {
  const count = BigInt(session.position.sequence) - BigInt(after);
  if (count === 0n) return { works: [], created: [] };
  if (count < 0n || count > BigInt(DISCOVERY_DELTA_COST.batches)) return null;
  const rows = await session
    .query(
      `SELECT ?batch ?sequence ?count ?event ?ordinal ?action ?work ?outcome ?ratingContext ?realm ?mainVersion ?ratingSlot ?chapterWork ?commandAction WHERE {
    VALUES ?sequence { ${Array.from({ length: Number(count) }, (_, i) => BigInt(after) + BigInt(i + 1)).join(' ')} }
    GRAPH ${iri(GRAPHS.outbox)} {
      ?batch a rv:OutboxBatch ; rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence ; rv:eventCount ?count .
      OPTIONAL { ?batch rv:event ?event .
        OPTIONAL { ?event rv:ordinal ?ordinal ; rv:action ?action }
        ${['work', 'outcome', 'ratingContext', 'realm', 'mainVersion', 'ratingSlot', 'chapterWork']
          .map((field) => `OPTIONAL { ?event rv:${field} ?event_${field} }`)
          .join('\n')}
        OPTIONAL { ?event rv:receipt ?receipt . GRAPH ${iri(GRAPHS.receipts)} {
          OPTIONAL { ?receipt rv:action ?commandAction }
          ${[
            'work',
            'outcome',
            'ratingContext',
            'realm',
            'mainVersion',
            'ratingSlot',
            'chapterWork',
          ]
            .map((field) => `OPTIONAL { ?receipt rv:${field} ?receipt_${field} }`)
            .join('\n')}
        } } }
    }
    ${['work', 'outcome', 'ratingContext', 'realm', 'mainVersion', 'ratingSlot', 'chapterWork']
      .map(
        (field) =>
          `FILTER(!BOUND(?event_${field}) || !BOUND(?receipt_${field}) || ?event_${field}=?receipt_${field})
       BIND(COALESCE(?event_${field},?receipt_${field}) AS ?${field})`,
      )
      .join('\n')}
  } LIMIT ${DISCOVERY_DELTA_COST.events + 1}`,
      DISCOVERY_DELTA_COST.events + 1,
    )
    .catch((error) => {
      // A dense interval falls back to bounded source pages; it must not retry
      // the same oversized delta forever after writers have become idle.
      if (error instanceof WorkReadLimit || error instanceof FusekiQueryResponseTooLarge)
        return null;
      throw error;
    });
  if (!rows || rows.length > DISCOVERY_DELTA_COST.events) return null;
  const batches = new Map<string, typeof rows>();
  const works = new Set<string>(),
    created = new Set<string>();
  for (const row of rows) {
    if (!row.sequence || !row.batch || !row.count || !row.event || !row.ordinal || !row.action)
      return null;
    const event = {
      action: row.action.value,
      work: row.work?.value,
      realm: row.realm?.value,
      ratingContext: row.ratingContext?.value,
      mainVersion: row.mainVersion?.value,
      ratingSlot: row.ratingSlot?.value,
      chapterWork: row.chapterWork?.value,
      commandAction: row.commandAction?.value,
      outcome: row.outcome?.value.endsWith('Cancelled') ? 'cancelled' : 'succeeded',
    };
    const effect = discoveryEventEffect(event, basis);
    if (!effect || effect === 'scope') return null;
    if (effect === 'work') {
      const local = discoveryEventWorks(event);
      if (!local) return null;
      for (const work of local) works.add(work);
      if (event.action === 'work.create') for (const work of local) created.add(work);
    }
    batches.set(row.sequence.value, [...(batches.get(row.sequence.value) ?? []), row]);
  }
  if (batches.size !== Number(count)) return null;
  for (const batch of batches.values()) {
    if (
      new Set(batch.map((row) => row.batch!.value)).size !== 1 ||
      batch.some((row) => Number(row.count!.value) !== batch.length) ||
      new Set(batch.map((row) => row.event!.value)).size !== batch.length ||
      batch
        .map((row) => Number(row.ordinal!.value))
        .sort((a, b) => a - b)
        .some((value, i) => value !== i)
    )
      return null;
  }
  return { works: [...works].sort(), created: [...created].sort() };
}
