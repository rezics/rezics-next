import { readResourceVisibility, VISIBILITY_COST } from '../space/visibility.ts';
import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';

/** Exact live Space membership. A Zone's disclosure is that Space's disclosure.
 * Two bounded graph probes plus the private Realm's policy/proof; a Zone-only
 * private Space uses Zone read authority in place of Realm membership. Call
 * again at disclosure. */
export const ZONE_VISIBILITY_COST = { ...VISIBILITY_COST, realmPolicyReads: 1 } as const;
export async function readZoneVisibility(session: WorkReadSession, zone: string) {
  const visibility = await readResourceVisibility(session.deps.environment, zone, {
    realmReadProof: async realm => {
      await session.realm(realm);
      return 'admitted';
    },
    zoneReadable: async target => !!(session.principal && session.options.actingSubject
      && await session.deps.access.canReadSemanticResource?.(session.principal,
        session.options.actingSubject, target)),
  });
  if (!visibility?.readable) throw new WorkReadMissing('Zone is unavailable');
  return visibility;
}
