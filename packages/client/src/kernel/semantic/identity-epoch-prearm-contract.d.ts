import type { Pool } from 'pg';
import type { IdentityJobRef, IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityScopeKey } from './identity-scope-types.ts';
export type IdentityPrearmTicketLocator = Readonly<{
    job: IdentityJobRef;
    directory: IdentityNativeReceipt;
    pageId: string;
    ordinal: number;
}>;
export type IdentityPrearmTicketData = Readonly<{
    locator: IdentityPrearmTicketLocator;
    scope: IdentityScopeKey;
    registration: string;
    captureId: string;
    attempt: IdentityNativeReceipt;
}>;
/** Resolve pinned native page custody, releasing its home before returning. */
export declare function readIdentityPrearmTicket(pool: Pool, locator: IdentityPrearmTicketLocator): Promise<IdentityPrearmTicketData | null>;
