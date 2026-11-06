import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import storeSelectJob from './identity-epoch-store-select-job.sql';
import storeSelectAck from './identity-epoch-store-select-ack.sql';
import storeSelectStep from './identity-epoch-store-select-step.sql';
import storeSelectJob5 from './identity-epoch-store-select-job-5.sql';
import storeSelectEffectReceipt from './identity-epoch-store-select-effect-receipt.sql';
import storeSelectAck2 from './identity-epoch-store-select-ack-2.sql';

const classified = (nativeRows: number, nativePoints: number, statements: number, bytes: number, emptySeeks: number) =>
  Object.freeze({
    engineRequests: 0 as const,
    work: Object.freeze({
      candidateKeys: 0,
      nativeRows,
      identityMetadataRows: 0,
      nativePoints,
      witnessKeys: 0,
      statements,
      bytes,
      emptySeeks,
    }),
  });

/** identityEpochStore.readJob: owner row, job, and at most three ACK rows. */
export function IDENTITY_EPOCH_JOB_READ_DECLARATION() {
  return memoizedValue(IDENTITY_EPOCH_JOB_READ_DECLARATION, () =>
    classified(
      5,
      5,
      3,
      statementBytes(`SELECT epoch,write_state FROM core.partition WHERE partition_no=$1`) +
        statementBytes(storeSelectJob) +
        statementBytes(storeSelectAck) +
        6 * (36 + 19 + 10) +
        16384,
      3,
    ),
  );
}

/** Complete-ACK reread used by original-source publication: native step, job, empty outstanding, existing ACK.
 * Insert-and-event is a Mapping/Search/Library producer body, not this receiving walk. */
export function IDENTITY_EPOCH_STEP_RECONCILE_DECLARATION() {
  return memoizedValue(IDENTITY_EPOCH_STEP_RECONCILE_DECLARATION, () =>
    classified(
      8,
      8,
      4,
      statementBytes(storeSelectStep) +
        statementBytes(storeSelectJob5) +
        statementBytes(storeSelectEffectReceipt) +
        statementBytes(storeSelectAck2) +
        6 * (36 * 3 + 19 * 2 + 32) +
        16384,
      4,
    ),
  );
}
