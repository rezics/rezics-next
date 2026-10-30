import type { IdentityEpochStep } from '../semantic/identity-epoch-contract.ts';
import { identityEpochStore, IdentityEpochStoreError } from '../semantic/identity-epoch-store.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { routeOf } from '../route/route.ts';

/**
 * Fixed ALL-Library boundary. Missing native role producers keep admission unavailable;
 * empty derived tables cannot supply coverage or a participant completion receipt.
 * See README.md's native identity participant prerequisites before adding effects here.
 */
export const stepLibraryIdentityEpoch: IdentityEpochStep = async (pool, job) => {
  if (routeOf(job.jobId) === null || typeof job.epoch !== 'bigint' || job.epoch <= 0n)
    throw new TypeError('Library identity work requires a native job ID and positive bigint epoch');

  const saved = await withReadTransaction(pool, (tx) => identityEpochStore.readJob(tx, job));
  if (!saved || (saved.state !== 'pending' && saved.state !== 'published'))
    throw new IdentityEpochStoreError('identity_effect_stale', 'Library identity work requires an admitted native job');

  // The read home is released before Store resolves the native receipt and takes control custody.
  // Only a previously custodied ALL-role receipt can use this replay path. Never reconstruct
  // progress, a native component, or an ACK from local exhaustion or workflow output.
  const previous = saved.participants['library-private-follow-counts'];
  if (previous) {
    const receipt = previous.receipt;
    if (
      previous.state !== 'complete' ||
      previous.job.jobId !== job.jobId ||
      previous.job.epoch !== job.epoch ||
      receipt.job.jobId !== job.jobId ||
      receipt.job.epoch !== job.epoch ||
      receipt.step !== 'library-private-follow-counts' ||
      receipt.version !== 1
    )
      throw new IdentityEpochStoreError('identity_step_receipt_invalid', 'Library identity receipt scope is invalid');
    return identityEpochStore.reconcileStepReceipt(pool, receipt);
  }

  // The installed Store admits structural effects only at the original's home, while
  // Library effects belong to source/owner/receiving homes. Neither this read nor the
  // ordinary follow-count branch grants that missing same-transaction admission.
  throw new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'ALL-Library identity effects require native owner-home admission, six-driver source registration, ' +
      'structural owner coverage and canonical follow receiving custody',
  );
};
