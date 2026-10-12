import { RightsUnavailable, type RightsStore } from './store.ts';

export interface DeliveryCutSnapshot {
  assessmentHead: string | null;
  preservationVersion: string;
  held: boolean;
}

export interface DeliveryCutTarget {
  resourceId: string;
  /** Assessment carried by the delivered revision, or null for unassessed material. */
  assessmentId: string | null;
  rights?: Pick<RightsStore, 'deliveryCutSnapshot'>;
}

export type DeliveryCutResult<T> = { status: 'stable'; value: T }
  | { status: 'denied' }
  | { status: 'unavailable-retry' };

/**
 * Authorize before every attempt, then replay the complete read and publication
 * query. finalFence must evaluate disclosure on a fresh owner snapshot after
 * that query and retain graph-erasure checks. Both callbacks are read-only:
 * their first result may be discarded. This does not lock all three owners.
 */
export async function withDeliveryCut<T>(target: DeliveryCutTarget,
  authorize: () => Promise<boolean>, work: () => Promise<T>,
  finalFence: (value: T) => Promise<T>): Promise<DeliveryCutResult<T>> {
  const { rights, resourceId, assessmentId } = target;
  for (let attempt = 0; attempt < 2; attempt++) {
    // No owner state, including a hold or outage, may reveal a hidden target.
    if (!await authorize()) return { status: 'denied' };
    if (!rights) return { status: 'unavailable-retry' };
    let before: DeliveryCutSnapshot;
    try { before = await rights.deliveryCutSnapshot(resourceId, assessmentId); }
    catch (error) {
      if (!(error instanceof RightsUnavailable)) throw error;
      return { status: 'unavailable-retry' };
    }
    if (before.held) return { status: 'unavailable-retry' };
    const value = await finalFence(await work());
    let after: DeliveryCutSnapshot;
    try { after = await rights.deliveryCutSnapshot(resourceId, assessmentId); }
    catch (error) {
      if (!(error instanceof RightsUnavailable)) throw error;
      return { status: 'unavailable-retry' };
    }
    if (before.assessmentHead === after.assessmentHead
      && before.preservationVersion === after.preservationVersion && !after.held) {
      return { status: 'stable', value };
    }
  }
  return { status: 'unavailable-retry' };
}
