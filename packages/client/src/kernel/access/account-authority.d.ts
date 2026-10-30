import type { AccessClient } from '../request/access.ts';
import type { Account } from './account-data.ts';
import { type AccessWorkAccounting } from './work.ts';
/** Only native permission facts; never manufacture a full private Account. */
export type PermissionAccount = Pick<Account, 'route' | 'accountId' | 'kind' | 'state' | 'fenced' | 'operatorAccountId' | 'minimumAuthnEpoch'>;
/** Exact installed account-viewer-actions.sql projection, bounded by full keys.
 * Neither profile text nor bearer material enters the statement or receipt.
 */
export declare function readNativeAccountStates(client: AccessClient, ids: readonly string[], work?: AccessWorkAccounting): Promise<{
    id: string;
    kind: "actor" | "organization";
    state: "pending" | "active" | "suspended" | "deleted";
    fenced: boolean;
    operatorAccountId: string | null;
    minimumAuthnEpoch: string;
}[]>;
export declare function readNativePermissionAccount(client: AccessClient, id: string, work: AccessWorkAccounting): Promise<PermissionAccount | null>;
/** Native public-account floor. The owner receipt describes the SAME one full-key
 * statement executed by verify; preparation is genuinely synchronous zero IO.
 */
export declare function createAccountPublicEligibility(target: import('../request/access.ts').Resource): import("./eligibility.ts").ResourceEligibility;
