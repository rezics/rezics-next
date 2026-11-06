import type { PublicIdentityOutputWork } from './identity-public-output-types.ts';
import type { WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { Pool } from 'pg';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketLocator } from './identity-epoch-prearm-contract.ts';
/** PREPARATION custody only. The directory home is released before opening the Source command. */
export declare function receiveIdentityScopePrearm(pool: Pool, locator: IdentityPrearmTicketLocator, outputWork?: PublicIdentityOutputWork): Promise<IdentityNativeReceipt & {
    work?: WorkReceipt;
}>;
export declare function cancelIdentityScopePrearm(pool: Pool, input: {
    locator: IdentityPrearmTicketLocator;
    cancellation: IdentityNativeReceipt;
    outputWork?: PublicIdentityOutputWork;
}): Promise<IdentityNativeReceipt & {
    work?: WorkReceipt;
}>;
