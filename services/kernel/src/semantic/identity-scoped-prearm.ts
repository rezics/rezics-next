import type { Pool } from 'pg';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketLocator } from './identity-epoch-prearm-contract.ts';
import { readIdentityPrearmTicket } from './identity-epoch-prearm-contract.ts';
import { IdentityEpochStoreError } from './identity-epoch-store.ts';
import { receiveScopePreparation } from './identity-scoped-observations.ts';

/** PREPARATION custody only. The directory home is released before opening the Source command. */
export async function receiveIdentityScopePrearm(
  pool: Pool,
  locator: IdentityPrearmTicketLocator,
): Promise<IdentityNativeReceipt> {
  const ticket = await readIdentityPrearmTicket(pool, locator);
  if (!ticket) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native pre-arm ticket unavailable');
  return receiveScopePreparation(pool, ticket);
}

export async function cancelIdentityScopePrearm(
  pool: Pool,
  input: { locator: IdentityPrearmTicketLocator; cancellation: IdentityNativeReceipt },
): Promise<IdentityNativeReceipt> {
  const ticket = await readIdentityPrearmTicket(pool, input.locator);
  if (!ticket) throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native pre-arm ticket unavailable');
  return receiveScopePreparation(pool, ticket, input.cancellation);
}
