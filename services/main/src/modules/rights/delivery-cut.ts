import { RightsUnavailable, type RightsStore } from './store.ts';

export interface DeliveryCutSnapshot {
  assessmentHead: string | null;
  preservationVersion: string;
  held: boolean;
}

export interface DeliveryCutTarget {
  resourceId: string;
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
  if (!target.rights) return { status: 'unavailable-retry' };
  for (let attempt = 0; attempt < 2; attempt++) {
    let before: DeliveryCutSnapshot;
    try { before = await target.rights.deliveryCutSnapshot(target.resourceId); }
    catch (error) {
      if (!(error instanceof RightsUnavailable)) throw error;
      return { status: 'unavailable-retry' };
    }
    if (before.held) return { status: 'unavailable-retry' };
    const value = await work();
    let after: DeliveryCutSnapshot;
    try { after = await target.rights.deliveryCutSnapshot(target.resourceId); }
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
