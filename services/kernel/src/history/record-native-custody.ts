import * as custody from '../semantic/record-purge-custody.ts';

export type {
  RecordPurgeReceivingHold,
  RecordPurgeInventoryCut,
  RecordPurgeReceivingTarget,
} from '../semantic/record-purge-custody.ts';
export type RecordPurgeNativeCustody = typeof custody;

/** Native Source owns generation, restore exclusion, receiving locks and completion. */
export async function nativeRecordPurgeCustody(): Promise<RecordPurgeNativeCustody> {
  return custody;
}
