import { readZoneVisibilities, VISIBILITY_COST } from '../space/visibility.ts';
import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

/** Exact live Space membership. A Zone's disclosure is that Space's disclosure.
 * Two bounded graph probes plus the private Realm's policy/proof; a Zone-only
 * private Space uses Zone read authority in place of Realm membership. Call
 * again at disclosure. */
export const ZONE_VISIBILITY_COST = { ...VISIBILITY_COST, realmPolicyReads: 1 } as const;
export async function readZoneVisibility(session: WorkReadSession, zone: string) {
  // The batch owner proves lineage, the restore fence and Zone identity in one
  // graph statement. A point read should use that same bounded owner read.
  const visibility = (await readZoneVisibilities(session.deps.environment, [zone], {
    realmReadProof: async realm => {
      await session.realm(realm);
      return 'admitted';
    },
    zoneReadable: async target => !!(session.principal && session.options.actingSubject
      && await session.deps.access.canReadSemanticResource?.(session.principal,
        session.options.actingSubject, target)),
  })).get(zone);
  if (!visibility) {
    // An empty relation can mean an absent Zone or a recovery hold. Preserve
    // the recovery refusal rather than turning an unavailable graph into 404.
    await assertGraphAdmissionOpen(session.deps.environment.fuseki, session.deps.environment.lineage);
  }
  if (!visibility?.readable) throw new WorkReadMissing('Zone is unavailable');
  return visibility;
}
