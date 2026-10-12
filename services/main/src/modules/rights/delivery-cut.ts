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
  | { status: 'unavailable-retry' };

/**
 * Replay the complete delivery read, including its Rights, disclosure and final
 * graph-erasure checks. A callback must be read-only: its first result may be
 * discarded. This detects owner movement; it does not lock all three owners.
 */
export async function withDeliveryCut<T>(target: DeliveryCutTarget,
  work: () => Promise<T>): Promise<DeliveryCutResult<T>> {
  const { rights, resourceId, assessmentId } = target;
  if (!rights) return { status: 'unavailable-retry' };
  for (let attempt = 0; attempt < 2; attempt++) {
    let before: DeliveryCutSnapshot;
    try { before = await rights.deliveryCutSnapshot(resourceId, assessmentId); }
    catch (error) {
      if (!(error instanceof RightsUnavailable)) throw error;
      return { status: 'unavailable-retry' };
    }
    if (before.held) return { status: 'unavailable-retry' };
    const value = await work();
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
