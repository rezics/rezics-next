import { receivePublicIdentityOutputCapturePrearm } from './identity-public-output-capture.ts';
import type { PublicIdentityOutputWork } from './identity-public-output-types.ts';
import type { WorkReceipt } from '../library/collection-source.ts';
import type { Pool } from 'pg';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketLocator } from './identity-epoch-prearm-contract.ts';
import { readIdentityPrearmTicket } from './identity-epoch-prearm-contract.ts';
import { IdentityEpochStoreError } from './identity-adapters/index.ts';
import { receiveScopePreparation } from './identity-scoped-observations.ts';

/** PREPARATION custody only. The directory home is released before opening the Source command. */
export async function receiveIdentityScopePrearm(
  pool: Pool,
  locator: IdentityPrearmTicketLocator,
  outputWork?: PublicIdentityOutputWork,
): Promise<IdentityNativeReceipt & { work?: WorkReceipt }> {
  if (outputWork) {
    const result = await receivePublicIdentityOutputCapturePrearm(pool, locator, outputWork);
    if (result.status !== 'received')
      throw Object.assign(
        new IdentityEpochStoreError('identity_epoch_unavailable', 'Output pre-arm retained: ' + result.reason),
        { work: result.work },
      );
    return { ...result.native, work: result.work };
  }
  const ticket = await readIdentityPrearmTicket(pool, locator);
  if (!ticket) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native pre-arm ticket unavailable');
  return receiveScopePreparation(pool, ticket);
}

export async function cancelIdentityScopePrearm(
  pool: Pool,
  input: {
    locator: IdentityPrearmTicketLocator;
    cancellation: IdentityNativeReceipt;
    outputWork?: PublicIdentityOutputWork;
  },
): Promise<IdentityNativeReceipt & { work?: WorkReceipt }> {
  if (input.outputWork) {
    const result = await receivePublicIdentityOutputCapturePrearm(
      pool,
      input.locator,
      input.outputWork,
      input.cancellation,
    );
    if (result.status !== 'received')
      throw Object.assign(
        new IdentityEpochStoreError('identity_epoch_unavailable', 'Output cancellation retained: ' + result.reason),
        { work: result.work },
      );
    return { ...result.native, work: result.work };
  }
  const ticket = await readIdentityPrearmTicket(pool, input.locator);
  if (!ticket) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native pre-arm ticket unavailable');
  return receiveScopePreparation(pool, ticket, input.cancellation);
}
