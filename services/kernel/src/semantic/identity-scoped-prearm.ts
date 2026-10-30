import type { Pool } from 'pg';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketLocator } from './identity-epoch-prearm-contract.ts';
import { IdentityEpochStoreError } from './identity-epoch-store.ts';

/** Provisional agreed Source exports. The Source owner replaces this file on integration. */
export async function receiveIdentityScopePrearm(
  _pool: Pool,
  _locator: IdentityPrearmTicketLocator,
): Promise<IdentityNativeReceipt> {
  throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native Source pre-arm receiving is unavailable');
}

export async function cancelIdentityScopePrearm(
  _pool: Pool,
  _input: { locator: IdentityPrearmTicketLocator; cancellation: IdentityNativeReceipt },
): Promise<IdentityNativeReceipt> {
  throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native Source pre-arm cancellation is unavailable');
}
