import { AsyncLocalStorage } from 'node:async_hooks';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { GraphLineage } from '../work/activate.ts';
import type { PublicTextPosition } from '../work/search-readiness.ts';

/** Only the search route's final, uncached graph/instance fence may own this
 * scope. Never retain it across requests or retry attempts. */
export const searchGraphSnapshot = new AsyncLocalStorage<{
  clients: Set<FusekiClient>; lineage: GraphLineage; position: PublicTextPosition;
}>();

export function knownSearchPosition(fuseki: FusekiClient, lineage: GraphLineage) {
  const snapshot = searchGraphSnapshot.getStore();
  return snapshot?.clients.has(fuseki) && snapshot.lineage.dataEpoch === lineage.dataEpoch
    && snapshot.lineage.routingEpoch === lineage.routingEpoch ? snapshot.position : undefined;
}
